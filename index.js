// credits to https://github.com/gautamkrishnar/blog-post-workflow

const https = require("https");
const fs = require("fs");
const core = require("@actions/core");
const parser = require("fast-xml-parser");
const exec = require("./exec");

const GOODREADS_USER_ID = core.getInput("goodreads_user_id");
const SHELF = core.getInput("shelf");
const MAX_BOOKS_COUNT = Number.parseInt(core.getInput("max_books_count"));
const README_FILE_PATH = core.getInput("readme_file_path");
const OUTPUT_ONLY = core.getInput("output_only").toLowerCase() === "true";
const TEMPLATE =
  core.getInput("template") ||
  "- [$title]($url) by $author (⭐️$average_rating)";
const COMMIT_MESSAGE = "Synced and updated with user's goodreads book lists";
const COMMITTER_USERNAME = "goodreads-books-bot";
const COMMITTER_EMAIL = "goodreads-books-bot@example.com";
const SORT_BY_FIELDS = core.getInput("sort_by_fields");
const SORT_FIELDS_BY_DATE = [
  "pubDate",
  "user_read_at",
  "user_date_added",
  "user_date_created"
]; // these fields need to be sorted by date values instead of string values

requestList(GOODREADS_USER_ID, SHELF)
  .then(async (data) => {
    try {
      // check if there are any books in the shelf
      if (!data || !data.rss || !data.rss.channel || !data.rss.channel.item) {
        return;
      }
      const items = Array.isArray(data.rss.channel.item)
        ? data.rss.channel.item
        : [data.rss.channel.item];
      const sortedBooks = sortBy(items, SORT_BY_FIELDS);
      const books = sortedBooks.slice(0, MAX_BOOKS_COUNT);
      const readme = fs.readFileSync(README_FILE_PATH, "utf8");
      const updatedReadme = buildReadme(readme, books);
      if (readme !== updatedReadme) {
        core.info(`Writing to ${README_FILE_PATH}`);
        // output the books in the logs
        core.startGroup("New books found for update");
        books.forEach((book) => core.info(JSON.stringify(book)));
        core.endGroup();

        fs.writeFileSync(README_FILE_PATH, updatedReadme);

        if (!OUTPUT_ONLY) {
          await commitReadme();
        } else {
          core.setOutput("books", books);
          core.info(
            "OUTPUT_ONLY: set `results` variable. Readme not committed."
          );
        }
      }
    } catch (err) {
      core.error(err);
      process.exit(1);
    }
  })
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    // maybe GOODREADS_USER_ID, SHELF or goodreads itself is not available
    core.error(err);
    process.exit(1);
  });

function requestList(userId, shelf) {
  return new Promise((resolve, reject) => {
    https
      .request(
        {
          host: "www.goodreads.com",
          path: `/review/list_rss/${userId}?shelf=${shelf}`
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => resolve(parser.parse(data)));
          response.on("error", (err) => reject(err));
        }
      )
      .end();
  });
}

function buildReadme(template, books) {
  const tagName = core.getInput("comment_tag_name") || "GOODREADS-LIST";
  const startTag = `<!-- ${tagName}:START -->`;
  const endTag = `<!-- ${tagName}:END -->`;

  const hasRequiredComments = [startTag, endTag].every((tag) =>
    template.match(new RegExp(tag, "gm"))
  );

  if (!hasRequiredComments) {
    core.error(
      `Cannot find the required comment tags (${startTag} and ${endTag}) to inject book titles.`
    );
    process.exit(1);
  } else {
    const startIndex = template.indexOf(startTag);
    const endIndex = template.indexOf(endTag);
    const replaceContent = buildBookList(books);
    return [
      template.substring(0, startIndex + startTag.length),
      `\n`,
      replaceContent,
      `\n`,
      template.substring(endIndex)
    ].join("");
  }
}

function buildBookList(books) {
  return books
    .map((book) => {
      return template(TEMPLATE, {
        title: book.title,
        url: book.link,
        author: book.author_name,
        published_year: book.book_published,
        average_rating: book.average_rating,
        my_rating: book.user_rating,
        my_rating_stars: book.user_rating
          ? "⭐".repeat(Number.parseInt(book.user_rating || "0"))
          : "unrated"
      });
    })
    .join(`\n`);
}

function sortBy(books, sortString) {
  if (!sortString || 0 === sortString.length) {
    return books;
  }
  const tokens = sortString.split(",");
  const sortProps = tokens.map((v) => ({
    term: v.replace(/<|>/g, (x) => ""),
    direction: v.indexOf("<") > -1 ? "asc" : "desc"
  }));
  return books.sort((bookA, bookB) => {
    return sortProps
      .map((prop) => {
        const numeric = !isNaN(bookA[prop.term]) && !isNaN(bookB[prop.term]);
        // -1 ascending
        //  1 descending
        const sort = prop.direction === "asc" ? -1 : 1;
        let termA;
        let termB;

        // check if the prop is a date prop
        if (SORT_FIELDS_BY_DATE.includes(prop.term)) {
          termA = bookA[prop.term]
            ? new Date(bookA[prop.term]).getTime() + ""
            : "";
          termB = bookB[prop.term]
            ? new Date(bookB[prop.term]).getTime() + ""
            : "";
        } else {
          termA = String(bookA[prop.term]);
          termB = String(bookB[prop.term]);
        }
        return termB.localeCompare(termA, "en", { numeric }) * sort;
      })
      .reduce((root, result) => {
        return root === 0 ? result : root;
      }, 0);
  });
}

function template(template, variables) {
  const regex = /\$([a-zA-Z_]*)/g;
  return template.replace(regex, (match, content) => variables[content] || "");
}

async function commitReadme() {
  // Doing commit and push
  await exec("git", ["config", "--global", "user.email", COMMITTER_EMAIL]);
  await exec("git", ["config", "--global", "user.name", COMMITTER_USERNAME]);
  await exec("git", ["add", README_FILE_PATH]);
  await exec("git", ["commit", "-m", COMMIT_MESSAGE]);
  await exec("git", ["push"]);
  core.info("Readme updated successfully in the upstream repository");
  // Making job fail if one of the source fails
  process.exit(0);
}
