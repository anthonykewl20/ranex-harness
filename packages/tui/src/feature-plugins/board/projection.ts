export type ProjectionField<T> =
  | { readonly state: "available"; readonly value: T }
  | { readonly state: "unavailable"; readonly why: string }

export type BoardProjectionCause = {
  readonly claim_id: string | null
  readonly cause: string
  readonly detail?: string
}

export type BoardProjectionFilter = {
  readonly name: string
  readonly value: string
}

/** The complete export shape, including fields the board cannot read yet. */
export type BoardProjectionRecord = {
  readonly subject_digest: string
  readonly gate_id: ProjectionField<string>
  readonly catalog_digest: ProjectionField<string | null>
  readonly verdict: "PASS" | "FAIL"
  readonly causes: ProjectionField<readonly BoardProjectionCause[]>
  readonly filters: readonly BoardProjectionFilter[]
}

export function projectBoard(record: BoardProjectionRecord): string {
  if (!record.subject_digest.trim()) throw new Error("export needs a subject digest")

  return [
    "PROJECTION of a verdict, not a signed record.",
    `subject digest: ${record.subject_digest}`,
    `gate id: ${renderField(record.gate_id, (value) => value)}`,
    `catalog digest: ${renderField(record.catalog_digest, (value) => value ?? "none bound")}`,
    `verdict: ${record.verdict}`,
    "filters:",
    ...(record.filters.length
      ? record.filters.flatMap((filter) => [`  - name: ${filter.name}`, `    value: ${filter.value}`])
      : ["  none"]),
    "causes:",
    ...renderCauses(record.causes),
    "",
  ].join("\n")
}

function renderField<T>(field: ProjectionField<T>, render: (value: T) => string): string {
  if (field.state === "unavailable") return `unavailable — ${field.why}`
  return render(field.value)
}

function renderCauses(field: ProjectionField<readonly BoardProjectionCause[]>): readonly string[] {
  if (field.state === "unavailable") return [`  unavailable — ${field.why}`]
  if (!field.value.length) return ["  none"]

  return field.value.flatMap((cause) => [
    `  - claim id: ${cause.claim_id ?? "none"}`,
    `    cause: ${cause.cause}`,
    `    detail: ${cause.detail ?? "unavailable"}`,
  ])
}
