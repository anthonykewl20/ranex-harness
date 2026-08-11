import { createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"

/**
 * CHAT-04 / CHAT-07 — markdown, rendered as markdown.
 *
 * The first revision rendered it through the **code** element with
 * `filetype="markdown"`, which treats the text as *source*: it highlights
 * markdown's own syntax rather than applying it. Headings, bold runs, inline
 * code and lists all came out flat, which is what the owner saw and what
 * opencode #15141 (headings with no visual hierarchy) describes. The `markdown`
 * element applies the formatting, so emphasis and inline code carry colour.
 *
 * The palette is the one the theme context already computed from the generated
 * theme — not a second one derived here. That is the rule glamour breaks at
 * `docs/adr/prior-art/ADR-022/glamour-codeblock.go:86`, overwriting the caller's
 * theme with a globally registered style named `charm` and capping the formatter
 * at `terminal256`: claude-code #70496 and #77920 in one file.
 *
 * Because the palette is `visual-identity.md`'s, two properties come free: every
 * emitted pair has passed the WCAG contrast gate at build time, and `pass`/`fail`
 * are reserved as verdict tokens, so no syntax token can borrow them and make a
 * verdict ambiguous (claude-code #35288 renders code in the diff palette).
 *
 * This reads the theme **context** rather than the narrowed `api.theme.current` a
 * third-party plugin sees. The transcript is a builtin, the same way the sidebar
 * plugins reach `component/todo-item`. A third-party plugin cannot reach the
 * syntax styles, and should not — that is the boundary stopping one from
 * shipping its own palette.
 */
export function Markdown(props: { content: string; muted?: boolean; streaming?: boolean }) {
  const { theme, syntax, subtleSyntax } = useTheme()
  const content = createMemo(() => props.content)

  return (
    <markdown
      syntaxStyle={props.muted ? subtleSyntax() : syntax()}
      streaming={props.streaming ?? true}
      internalBlockMode="top-level"
      content={content()}
      tableOptions={{ style: "grid" }}
      fg={props.muted ? theme.textMuted : theme.markdownText}
      bg={theme.background}
    />
  )
}
