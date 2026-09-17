const CleanCSS = require("clean-css");
const { feedPlugin } = require("@11ty/eleventy-plugin-rss");
const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const site = require("./src/_data/site.json");

module.exports = function (eleventyConfig) {
  // Prism-based syntax highlighting for fenced code blocks
  eleventyConfig.addPlugin(syntaxHighlight);
  // Pass through static assets, except CSS (compiled/minified below)
  eleventyConfig.addPassthroughCopy(
    "src/assets/**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,pdf,js}"
  );

  // Minify CSS at build time (source stays readable)
  eleventyConfig.addTemplateFormats("css");
  eleventyConfig.addExtension("css", {
    outputFileExtension: "css",
    compile: (inputContent) => () =>
      new CleanCSS({ level: 2 }).minify(inputContent).styles
  });

  // Atom feed
  eleventyConfig.addPlugin(feedPlugin, {
    type: "atom",
    outputPath: "/feed.xml",
    collection: {
      name: "posts",
      limit: 0
    },
    metadata: {
      language: "en",
      title: site.name,
      subtitle: site.description,
      base: site.url,
      author: {
        name: site.name
      }
    }
  });

  eleventyConfig.setServerOptions({ host: "127.0.0.1" });
  eleventyConfig.addFilter("postDate", (dateObj) =>
    new Date(dateObj).toISOString().slice(0, 10)
  );
  eleventyConfig.addFilter("isHtmlUrl", (url) =>
    Boolean(url) && (url.endsWith("/") || url.endsWith(".html"))
  );
  eleventyConfig.addShortcode("year", () => `${new Date().getFullYear()}`);

  return {
    dir: {
      input: "src",
      output: "_site"
    }
  };
};
