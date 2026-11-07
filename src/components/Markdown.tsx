import { memo, useMemo, useState } from "react";
import { LuImage, LuImageOff } from "react-icons/lu";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Fade, rehypeFade } from "../lib/reveal";
import { Lightbox } from "./Attachments";
import { Button } from "./Button";
import styles from "./Markdown.module.css";

const components: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
};

export const Markdown = memo(function Markdown({
  text,
  imageUrl,
  fade,
}: {
  text: string;
  /** Where to load images the text embeds by path rather than URL. Without it, they don't load. */
  imageUrl?: (path: string) => string;
  /** Letters of the text that are fading in, see `useReveal`. */
  fade?: Fade;
}) {
  const withImages = useMemo<Components>(
    () => ({
      ...components,
      img: ({ src, alt }) => {
        const url = typeof src === "string" ? src : "";
        return isUrl(url) ? (
          <RemoteImage key={url} src={url} alt={alt ?? ""} />
        ) : (
          <EmbeddedImage
            key={url}
            src={imageUrl?.(filePath(url))}
            alt={alt ?? ""}
          />
        );
      },
    }),
    [imageUrl],
  );
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={fade && [[rehypeFade, fade]]}
        components={withImages}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** An image in the text. Opening it shows it as large as fits. */
function EmbeddedImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // Files in the chat's folder can be gone, e.g. when it was cleared.
  if (!src || failed)
    return (
      <span className={styles.missingImage}>
        <LuImageOff size={14} aria-hidden />
        {alt ? `${alt} (image not available)` : "Image not available"}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className={styles.image}
        aria-label={alt ? `View image: ${alt}` : "View image"}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} onError={() => setFailed(true)} />
      </button>
      {open && <Lightbox src={src} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * An image from elsewhere, loaded only when asked to. Loading one sends a request to wherever the text
 * says, and a model misled by what it read could put anything it knows in the URL.
 */
function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [load, setLoad] = useState(false);
  if (load) return <EmbeddedImage src={src} alt={alt} />;
  return (
    <Button
      variant="secondary"
      size="small"
      title={src}
      onClick={() => setLoad(true)}
    >
      <LuImage size={14} aria-hidden />
      Load image from {hostOf(src)}
    </Button>
  );
}

/** URLs have a scheme, or start with `//`. Anything else is a path. */
function isUrl(src: string): boolean {
  return /^([a-z][a-z\d+.-]*:|\/\/)/i.test(src);
}

/** Who an image would be requested from. */
function hostOf(url: string): string {
  try {
    // The base is for `//` URLs.
    return new URL(url, "https://localhost").host || url;
  } catch {
    return url;
  }
}

/** The path the Markdown names, with `%20` and the like as the characters they stand for. */
function filePath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}
