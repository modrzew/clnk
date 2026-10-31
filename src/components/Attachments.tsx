import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuFile } from "react-icons/lu";
import type { Attachment, ImageContent } from "../../shared/protocol";
import { formatSize } from "../lib/format";
import styles from "./Attachments.module.css";

/** Thumbnails of a message's images. Opening one shows it as large as fits. */
export function ImageList({ images }: { images: ImageContent[] }) {
  const [open, setOpen] = useState<ImageContent | null>(null);
  return (
    <>
      <div className={styles.images}>
        {images.map((image, index) => (
          <button
            key={index}
            type="button"
            className={styles.thumbnail}
            aria-label="View image"
            onClick={() => setOpen(image)}
          >
            <img src={imageSrc(image)} alt="" />
          </button>
        ))}
      </div>
      {open && <Lightbox src={imageSrc(open)} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Files attached to a message, downloaded when opened. */
export function FileList({
  files,
  href,
}: {
  files: Attachment[];
  href: (name: string) => string;
}) {
  return (
    <ul className={styles.files}>
      {files.map((file) => (
        <li key={file.name}>
          <a
            className={styles.file}
            href={href(file.name)}
            download={file.name}
            // The apps' webviews don't download files. Links with a target open in the browser instead.
            target={isTauri() ? "_blank" : undefined}
            title={`Download ${file.name}`}
          >
            <LuFile size={16} className={styles.fileIcon} aria-hidden />
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{formatSize(file.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * An image over everything else. Closes on a click or Escape. Rendered in the body, so it can be opened
 * from inside a paragraph.
 */
export function Lightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={styles.lightbox}
      aria-label="Image"
      onClose={onClose}
      onClick={onClose}
    >
      <img src={src} alt="" />
    </dialog>,
    document.body,
  );
}

function imageSrc(image: ImageContent) {
  return `data:${image.mimeType};base64,${image.data}`;
}
