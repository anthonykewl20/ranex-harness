import { createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"

/**
 * CHAT-04 / CHAT-07 — markdown and code, from the theme and nowhere else.
 *
 * The syntax palette is the one the theme context already computed from the
 * generated theme values — not a second one derived here. That is the whole
 * rule, and it is what glamour gets wrong: read at
 * `docs/adr/prior-art/ADR-022/glamour-codeblock.go:86`, it overwrites the
 * caller's theme with a globally registered style named `charm` and defaults the
 * formatter to `terminal256`. The result is claude-code #70496 — a theme picker
 * that reaches only code blocks — and #77920, colour capped below true colour.
 *
 * Because the palette is `visual-identity.md`'s, two further properties come
 * free and are not restated in every renderer: every emitted pair has already
 * passed the WCAG contrast gate at build time, and `pass`/`fail` are reserved as
 * verdict tokens, so no syntax token can borrow them and make a verdict
 * ambiguous (claude-code #35288 renders code in the diff palette).
 *
 * Note this deliberately reads the theme **context** rather than the narrowed
 * `api.theme.current` a third-party plugin sees. The transcript is a builtin in
 * this package, the same way the sidebar plugins reach `component/todo-item`.
 * A third-party plugin cannot reach the syntax styles, and should not: that is
 * the boundary that stops one from shipping its own palette.
 */
export function Markdown(props: { content: string; muted?: boolean; streaming?: boolean }) {
  const { theme, syntax, subtleSyntax } = useTheme()
  // `subtle` is for secondary regions — reasoning bodies, tool output — so they
  // recede without inventing a second palette.
  const content = createMemo(() => props.content)

  return (
    <code
      filetype="markdown"
      drawUnstyledText={false}
      streaming={props.streaming ?? true}
      syntaxStyle={props.muted ? subtleSyntax() : syntax()}
      content={content()}
      fg={props.muted ? theme.textMuted : theme.text}
    />
  )
}
