import type { Element, ElementContent, Root } from "hast";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Letters are revealed at a rate that would show everything that arrived in this long. However fast the
 * text streams, what's shown trails it by about this much, and bursts are spread over a few frames.
 */
const LAG_MS = 80;
/** Fewest letters revealed per ms, so the end of a burst doesn't trickle in. */
const MIN_RATE = 0.2;
/** How long a revealed letter takes to fade in. */
const FADE_MS = 200;

/** Opacities of the letters from `from` on, which are fading in. */
export interface Fade {
  from: number;
  opacity: number[];
}

export interface Revealed {
  /** The part of the text to show. */
  text: string;
  fade?: Fade;
}

interface Mark {
  time: number;
  /** Letters revealed at that time. */
  end: number;
}

interface Progress {
  target: string;
  /** Letters revealed, with the part of the next one. */
  length: number;
  /** When the text was revealed up to where, back to the last letter that's done fading in. */
  marks: Mark[];
  rendered: Revealed;
  /** Time of the last frame, and how long its update took to render. */
  time: number;
  cost: number;
  frame: number;
}

/**
 * Reveals text that streams in letter by letter, fading them in. The text a component starts with, and
 * text that replaces rather than extends what's shown, is shown at once.
 */
export function useReveal(text: string): Revealed {
  const [revealed, setRevealed] = useState<Revealed>({ text });
  const progress = useRef<Progress>({
    target: text,
    length: text.length,
    marks: [],
    rendered: revealed,
    time: 0,
    cost: 0,
    frame: 0,
  });

  useEffect(() => {
    const p = progress.current;
    return () => {
      cancelAnimationFrame(p.frame);
      p.frame = 0;
    };
  }, []);

  useEffect(() => {
    const p = progress.current;
    const tick = (now: number) => {
      // Rendering long texts can take a while. Leave at least half the time to everything else, and
      // reveal more letters per update instead.
      if (now - p.time < 2 * p.cost) {
        p.frame = requestAnimationFrame(tick);
        return;
      }
      const { target, marks } = p;
      const rate = Math.max(MIN_RATE, (target.length - p.length) / LAG_MS);
      p.length = reducedMotion()
        ? target.length
        : Math.min(target.length, p.length + rate * Math.max(0, now - p.time));
      let end = Math.floor(p.length);
      // Not half an emoji.
      if (isHighSurrogate(target.charCodeAt(end - 1))) p.length = ++end;
      if (end > marks[marks.length - 1].end) marks.push({ time: now, end });
      while (marks.length > 1 && now - marks[1].time >= FADE_MS) marks.shift();

      const next: Revealed = {
        text: target.slice(0, end),
        fade: reducedMotion() ? undefined : fadeAt(marks, now),
      };
      if (next.text !== p.rendered.text || next.fade || p.rendered.fade) {
        const start = performance.now();
        // Rendered right away, so it's painted this frame.
        flushSync(() => setRevealed(next));
        p.cost = performance.now() - start;
        p.rendered = next;
      }
      p.time = now;
      p.frame =
        end < target.length || marks.length > 1
          ? requestAnimationFrame(tick)
          : 0;
    };

    if (!text.startsWith(p.rendered.text)) {
      p.length = text.length;
      p.marks = [{ time: performance.now(), end: text.length }];
    }
    p.target = text;
    if (!p.frame) {
      p.time = performance.now();
      p.marks = [{ time: p.time, end: Math.floor(p.length) }];
      p.frame = requestAnimationFrame(tick);
    }
  }, [text]);

  return text.startsWith(revealed.text) ? revealed : { text };
}

/** Opacities of the letters revealed since the first mark, as if revealed one by one between marks. */
function fadeAt(marks: Mark[], now: number): Fade | undefined {
  if (marks.length < 2) return undefined;
  const opacity: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1];
    const count = marks[i].end - prev.end;
    for (let n = 1; n <= count; n++) {
      const revealed = prev.time + ((marks[i].time - prev.time) * n) / count;
      const t = Math.min(1, (now - revealed) / FADE_MS);
      opacity.push(Math.round((1 - (1 - t) ** 2) * 100) / 100);
    }
  }
  return { from: marks[0].end, opacity };
}

let motionQuery: MediaQueryList | undefined;

function reducedMotion(): boolean {
  motionQuery ??= matchMedia("(prefers-reduced-motion: reduce)");
  return motionQuery.matches;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Part of a text, with the opacity of letters that are fading in. */
export interface Piece {
  text: string;
  opacity?: number;
}

/**
 * Splits text that starts at offset `first` of the revealed text into pieces to style. Whitespace and
 * letters done fading in are left as they are.
 */
export function fadePieces(text: string, first: number, fade: Fade): Piece[] {
  const from = Math.max(0, fade.from - first);
  // Letters made of several characters, like emoji or accented ones, fade in as one.
  const start = graphemes.segment(text).containing(from)?.index ?? from;
  const pieces: Piece[] = [{ text: text.slice(0, start) }];
  for (const { segment, index } of graphemes.segment(text.slice(start))) {
    const at = Math.min(
      first + start + index - fade.from,
      fade.opacity.length - 1,
    );
    const opacity = fade.opacity[Math.max(0, at)];
    const last = pieces[pieces.length - 1];
    if (opacity < 1 && /\S/.test(segment))
      pieces.push({ text: segment, opacity });
    else if (last.opacity === undefined) last.text += segment;
    else pieces.push({ text: segment });
  }
  return pieces.filter((piece) => piece.text);
}

/**
 * Rehype plugin that fades in letters of the Markdown source. A text node maps to the source by where it
 * ends, which is exact for the newest letters: what Markdown hides, like a link's URL, comes before them.
 */
export function rehypeFade(fade: Fade) {
  const visit = (parent: Root | Element, parentEnd: number) => {
    const { children } = parent;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      // Nodes like the text of a code block don't know where they are, but end with their parent.
      const end = child.position?.end.offset ?? parentEnd;
      if (end <= fade.from) continue;
      if (child.type === "element") visit(child, end);
      else if (child.type === "text")
        children.splice(
          i,
          1,
          ...fadePieces(child.value, end - child.value.length, fade).map(
            toNode,
          ),
        );
    }
  };
  return (tree: Root) => visit(tree, tree.position?.end.offset ?? 0);
}

function toNode({ text, opacity }: Piece): ElementContent {
  if (opacity === undefined) return { type: "text", value: text };
  return {
    type: "element",
    tagName: "span",
    properties: { style: `opacity: ${opacity}` },
    children: [{ type: "text", value: text }],
  };
}
