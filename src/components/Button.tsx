import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./Button.module.css";

/** A button element's attributes, but not its look, which the props of each kind of button steer. */
type ButtonAttributes = Omit<ComponentProps<"button">, "className" | "style">;

interface ButtonProps extends ButtonAttributes {
  /** Primary is filled with the accent color, for the main action. Secondary is outlined. */
  variant?: "primary" | "secondary";
  size?: "normal" | "small";
  /** For deleting: filled red, or red text when secondary. */
  danger?: boolean;
}

/** A labelled button, optionally with an icon before the label. */
export function Button({
  variant = "primary",
  size = "normal",
  danger,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      {...props}
      className={cx(
        styles.button,
        variant === "secondary" && styles.secondary,
        size === "small" && styles.small,
        danger && styles.danger,
      )}
    />
  );
}

interface IconButtonProps extends ButtonAttributes {
  size?: "normal" | "small";
  /** Turns red on hover, for deleting. */
  danger?: boolean;
}

/** A button showing just an icon. Give it an `aria-label`. */
export function IconButton({
  size = "normal",
  danger,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      {...props}
      className={cx(
        styles.iconButton,
        size === "small" && styles.small,
        danger && styles.danger,
      )}
    />
  );
}

interface LinkButtonProps extends ButtonAttributes {
  /** Sized like the text around it, for a link within a sentence. */
  inline?: boolean;
}

/** A button that looks like a link. */
export function LinkButton({
  inline,
  type = "button",
  ...props
}: LinkButtonProps) {
  return (
    <button
      type={type}
      {...props}
      className={cx(styles.linkButton, inline && styles.inline)}
    />
  );
}

/** A text toggle with a disclosure triangle, for showing and hiding what follows it. */
export function Disclosure({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.disclosure}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}
