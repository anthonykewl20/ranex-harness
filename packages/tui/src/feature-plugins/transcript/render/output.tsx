import { Show } from "solid-js"
import { useTheme } from "../../../context/theme"
import { detectGlyphs } from "../../../theme/glyphs"
import { filetype } from "../../../util/filetype"
import { Markdown } from "./markdown"

const glyphs = detectGlyphs()

/**
 * The container every tool result sits in — a frame, a header, a body.
 *
 * The frame is the point. Expanded output used to run flush into the
 * conversation with nothing marking where it began or ended, so a long result
 * read as more transcript. Framed, it is an object: you can see its extent
 * without reading it, and skip it without parsing it.
 *
 * `Diff` uses the identical shape deliberately — a result is a result, and two
 * containers differing only decoratively would make the reader learn two things.
 */
export function Panel(props: { title?: string; detail?: string; children: import("solid-js").JSXElement }) {
  const { theme } = useTheme()

  return (
    <box
      border={["left", "top", "right", "bottom"]}
      borderColor={theme.border}
      backgroundColor={theme.backgroundPanel}
      marginTop={1}
      flexShrink={0}
    >
      <Show when={props.title}>
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={theme.textMuted}>{glyphs.right}</text>
          <text fg={theme.text} flexGrow={1} wrapMode="none">
            {props.title}
          </text>
          <Show when={props.detail}>
            <text fg={theme.textMuted} flexShrink={0}>
              {props.detail}
            </text>
          </Show>
        </box>
      </Show>
      <box paddingLeft={1} paddingRight={1}>
        {props.children}
      </box>
    </box>
  )
}

/** Prose or unstructured output. */
export function Output(props: { content: string; title?: string; detail?: string }) {
  return (
    <Panel title={props.title} detail={props.detail}>
      <Markdown content={props.content} muted />
    </Panel>
  )
}

/**
 * File content, with a line-number gutter and real syntax highlighting.
 *
 * This is the shape a written file wants and a diff cannot give it: a new file
 * has no removals to contrast against, so rendering it as a wall of `+` lines
 * says nothing a line-numbered listing does not say better. Upstream reaches the
 * same conclusion for its Write tool, and this keeps that while putting it in
 * the same frame as every other result.
 */
export function Code(props: { content: string; path?: string; detail?: string }) {
  const { theme, syntax } = useTheme()

  return (
    <Panel title={props.path} detail={props.detail}>
      <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
        <code
          conceal={false}
          fg={theme.text}
          filetype={filetype(props.path ?? "")}
          syntaxStyle={syntax()}
          content={props.content}
        />
      </line_number>
    </Panel>
  )
}
