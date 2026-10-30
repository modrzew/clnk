import styles from "./Spinner.module.css";

export function Spinner({ label }: { label?: string }) {
  return <span className={styles.spinner} aria-label={label} />;
}
