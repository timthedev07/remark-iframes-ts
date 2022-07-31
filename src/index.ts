import { format, parse, URLSearchParams } from "url";
import visit from "unist-util-visit";
import fetch from "node-fetch";
import type { Root } from "mdast";
import type { Plugin } from "unified";

export interface Options {
  [hostname: string]: {
    tag?: string;
    width: number;
    height: number;
    disabled?: boolean;
    replace?: Array<[string, string]>;
    thumbnail?: {
      format: string;
      id: ".+/(.+)$";
    };
    removeAfter?: string;
    match?: RegExp;
    oembed?: string;
    append?: string;
    droppedQueryParameters?: string[];
    removeFileName?: boolean;
  };
}

const remarkIframesTS: Plugin<[Options?] | [void], Root> = (
  opts: void | Options | undefined
) => {
  const t = this as any;

  if (!opts) return;

  if (!opts || typeof opts !== "object" || !Object.keys(opts).length) {
    throw new Error(
      "remark-iframes-ts needs to be passed a configuration object as option"
    );
  }

  const detectProvider = (url: string) => {
    const hostname = parse(url).hostname;
    if (!hostname) {
      throw new Error("remark-iframes-ts found an invalid hostname");
    }
    return opts[hostname];
  };

  function blockTokenizer(eat: any, value: any, silent: any) {
    if (!value.startsWith("!(http")) return;

    let eatenValue = "";
    let url = "";
    const specialChars = ["!", "(", ")"];
    for (let i = 0; i < value.length && value[i - 1] !== ")"; i++) {
      eatenValue += value[i];
      if (!specialChars.includes(value[i])) {
        url += value[i];
      }
    }

    /* istanbul ignore if - never used (yet) */
    if (silent) return true;

    const provider = detectProvider(url);
    if (
      !provider ||
      provider.disabled === true ||
      (provider.match &&
        provider.match instanceof RegExp &&
        !provider.match.test(url))
    ) {
      return eat(eatenValue)({
        type: "paragraph",
        children: [
          {
            type: "text",
            value: eatenValue,
          },
        ],
      });
    }

    let finalUrl, thumbnail;
    const data = {
      hName: provider.tag || "iframe",
      hProperties: {
        src: "tmp",
        width: provider.width,
        height: provider.height,
        allowfullscreen: true,
        frameborder: "0",
      },
    };

    if (provider.oembed) {
      Object.assign(data, {
        oembed: {
          provider: provider,
          url: `${provider.oembed}?format=json&url=${encodeURIComponent(url)}`,
          fallback: {
            type: "link",
            url: url,
            children: [{ type: "text", value: url }],
          },
        },
      });
    } else {
      finalUrl = computeFinalUrl(provider, url);
      thumbnail = computeThumbnail(provider, finalUrl);

      Object.assign(data, {
        hProperties: {
          src: finalUrl,
          width: provider.width,
          height: provider.height,
          allowfullscreen: true,
          frameborder: "0",
        },
        thumbnail: thumbnail,
      });
    }

    eat(eatenValue)({
      type: "iframe",
      src: url,
      data,
    });
  }

  const Parser = t.Parser;

  // Inject blockTokenizer
  const blockTokenizers = Parser.prototype.blockTokenizers;
  const blockMethods = Parser.prototype.blockMethods;
  blockTokenizers.iframes = blockTokenizer;
  blockMethods.splice(blockMethods.indexOf("blockquote") + 1, 0, "iframes");

  const Compiler = t.Compiler;
  if (Compiler) {
    const visitors = Compiler.prototype.visitors;
    if (!visitors) return;
    visitors.iframe = (node: any) => `!(${node.src})`;
  }

  return async function transform(tree, vfile, next) {
    let toVisit = 0;
    (visit as any)(tree, "iframe", () => {
      toVisit++;
    });

    function nextVisitOrBail() {
      if (toVisit === 0) next();
    }
    nextVisitOrBail();

    (visit as any)(tree, "iframe", async (node: any) => {
      if (!node.data.oembed) {
        toVisit--;
        nextVisitOrBail();
        return;
      }
      const data = node.data;
      const oembed = data.oembed;
      const provider = data.oembed.provider;
      const fallback = data.oembed.fallback;
      try {
        const { url, thumbnail, height, width } = await fetchEmbed(oembed.url);

        node.thumbnail = thumbnail;
        Object.assign(data.hProperties, {
          src: url,
          width: provider.width || width,
          height: provider.height || height,
          allowfullscreen: true,
          frameborder: "0",
        });
      } catch (err: any) {
        let message = err.message;
        if (err.name === "AbortError") {
          message = `oEmbed URL timeout: ${oembed.url}`;
        }
        vfile.message(message, node.position, oembed.url);
        node.data = {};
        Object.assign(node, fallback);
      }
      delete data.oembed;
      toVisit--;
      nextVisitOrBail();
    });
  };
};

function computeFinalUrl(provider: any, url: string) {
  let finalUrl = url;
  let parsed = parse(finalUrl);

  if (provider.droppedQueryParameters && parsed.search) {
    const search = new URLSearchParams(parsed.search);
    provider.droppedQueryParameters.forEach((ignored: any) =>
      search.delete(ignored)
    );
    parsed.search = search.toString();
    finalUrl = format(parsed);
  }

  if (provider.replace && provider.replace.length) {
    provider.replace.forEach((rule: any) => {
      const [from, to] = rule;
      if (from && to) finalUrl = finalUrl.replace(from, to);
      parsed = parse(finalUrl);
    });
    finalUrl = format(parsed);
  }

  if (provider.removeFileName) {
    parsed.pathname = (parsed.pathname as any).substring(
      0,
      (parsed.pathname as any).lastIndexOf("/")
    );
    finalUrl = format(parsed);
  }

  if (provider.removeAfter && finalUrl.includes(provider.removeAfter)) {
    finalUrl = finalUrl.substring(0, finalUrl.indexOf(provider.removeAfter));
  }

  if (provider.append) {
    finalUrl += provider.append;
  }

  return finalUrl;
}

function computeThumbnail(provider: any, url: string) {
  let thumbnailURL = "";
  const thumbnailConfig = provider.thumbnail;
  if (thumbnailConfig && thumbnailConfig.format) {
    thumbnailURL = thumbnailConfig.format;
    Object.keys(thumbnailConfig)
      .filter((key) => key !== "format")
      .forEach((key) => {
        const search = new RegExp(`{${key}}`, "g");
        const replace = new RegExp(thumbnailConfig[key]).exec(url);
        if (replace) thumbnailURL = thumbnailURL.replace(search, replace[1]);
      });
  }
  return thumbnailURL;
}

async function fetchEmbed(url: string) {
  return fetch(url, { timeout: 1500 })
    .then((res) => res.json())
    .then((oembedRes) => {
      const oembedUrl = oembedRes.html.match(/src="(.+?)"/)[1];
      const oembedThumbnail = oembedRes.thumbnail_url;
      return {
        url: oembedUrl,
        thumbnail: oembedThumbnail,
        width: oembedRes.width,
        height: oembedRes.height,
      };
    });
}

export default remarkIframesTS;
