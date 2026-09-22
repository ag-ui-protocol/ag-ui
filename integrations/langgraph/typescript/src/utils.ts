import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { State, SchemaKeys, LangGraphReasoning } from "./types";
import {
  Message,
  ReasoningMessage,
  ToolCall,
  TextInputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  PartSource,
  InputContent,
  UserMessage,
  contentHasMedia,
  contentToText,
} from "@ag-ui/client";

export const DEFAULT_SCHEMA_KEYS = ["messages", "tools"];

export function filterObjectBySchemaKeys(
  obj: Record<string, any>,
  schemaKeys: string[],
) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => schemaKeys.includes(key)),
  );
}

export function getStreamPayloadInput({
  mode,
  state,
  schemaKeys,
}: {
  mode: "start" | "continue";
  state: State;
  schemaKeys: SchemaKeys;
}) {
  let input = mode === "start" ? state : null;
  // Do not input keys that are not part of the input schema
  if (input && schemaKeys?.input) {
    input = filterObjectBySchemaKeys(input, [
      ...DEFAULT_SCHEMA_KEYS,
      ...schemaKeys.input,
    ]);
  }

  return input;
}

const MEDIA_CONTENT_TYPES = new Set(["image", "audio", "video", "document"]);

/** Known WAV and MP3 aliases retained for downstream inline audio translation. */
const OPENAI_AUDIO_MIME_TYPES = new Map<string, string>([
  ["audio/wav", "audio/wav"],
  ["audio/x-wav", "audio/wav"],
  ["audio/wave", "audio/wav"],
  ["audio/vnd.wave", "audio/wav"],
  ["audio/mp3", "audio/mp3"],
  ["audio/mpeg", "audio/mp3"],
]);

/** Normalize known audio aliases; callers preserve other MIME types unchanged. */
function normalizedAudioMimeType(mimeType: unknown): string | undefined {
  const base = (firstNonEmptyString(mimeType) ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return OPENAI_AUDIO_MIME_TYPES.get(base);
}

/** Read base64 data URLs without decoding or changing their payload. */
function parseBase64DataUrl(
  value: unknown,
): { mimeType: string | undefined; data: string } | null {
  // Read through the same helper as every other off-the-wire string in this
  // file: a non-string `url` reaches both call sites (an inbound block relayed
  // by the graph, an AG-UI source built without validation), and `.startsWith`
  // on one throws out of the loop that converts the whole message list — rule 1
  // of THE MALFORMED-INPUT CONTRACT.
  const url = firstNonEmptyString(value);
  if (!url || !url.startsWith("data:")) return null;

  // Split on the FIRST comma and keep everything after it, for the reason the
  // `image_url` branch gives: base64 has no commas, but a payload that carries
  // one must not be silently truncated, and Python reads it with `split(",", 1)`.
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const data = url.slice(comma + 1);
  if (!data) return null;

  const parameters = url.slice("data:".length, comma).split(";");
  // Scanning the parameters rather than testing the last one: `;base64` is
  // documented as trailing, but `data:audio/wav;codecs=1;base64,…` is a shape
  // this can be handed and the encoding is still base64.
  if (
    !parameters
      .slice(1)
      .some((parameter) => parameter.trim().toLowerCase() === "base64")
  ) {
    return null;
  }
  return { mimeType: firstNonEmptyString(parameters[0].trim()), data };
}

/** Resolve inline bytes; a data URL MIME type takes precedence over source metadata. */
function inlineMediaData(
  source: PartSource | null | undefined,
): { value: string; mimeType: unknown } | null {
  // Read optionally for the reason {@link mediaSourceToUrl} gives: `source` is
  // declared required but arrives off the wire, and the two functions must not
  // disagree about whether it can be absent.
  if (source?.type === "data") {
    const value = firstNonEmptyString(source.value);
    return value ? { value, mimeType: source.mimeType } : null;
  }
  if (source?.type === "url") {
    const parsed = parseBase64DataUrl(source.value);
    if (parsed)
      return {
        value: parsed.data,
        mimeType: parsed.mimeType ?? source.mimeType,
      };
  }
  // Everything else — a `file` source included — carries no bytes this adapter
  // can reach. A `file` source names bytes ALREADY HELD BY A MODEL PROVIDER,
  // under a handle only that provider can resolve; it is not a URL and must not
  // be fetched or parsed. LangChain has no provider-handle block here, so it
  // takes the same exit as every other unusable source.
  return null;
}

/** Preserve modality independently of downstream provider capabilities. */
function standardBlockTypeFor(
  mediaType: string,
  mimeType: unknown,
  inline = true,
): { type: "audio" | "video" | "file"; mimeType?: string } | null {
  const mime = firstNonEmptyString(mimeType);
  const resolvedMime = inline ? (mime ?? "application/octet-stream") : mime;
  if (mediaType === "audio") {
    return {
      type: "audio",
      mimeType: inline ? (normalizedAudioMimeType(mime) ?? resolvedMime) : mime,
    };
  }
  if (mediaType === "video") return { type: "video", mimeType: resolvedMime };
  if (mediaType === "document") return { type: "file", mimeType: resolvedMime };
  return null;
}

/**
 * The file extension for a MIME type whose SUBTYPE IS NOT ITS EXTENSION.
 *
 * Only these need an entry. A subtype that already is the extension —
 * `application/pdf`, `text/csv`, `application/json`, `text/html`,
 * `application/zip`, `image/png` — falls through to the derivation in
 * {@link deriveFilename} and comes out right without being listed here, so
 * listing it would only be a second place to keep correct.
 *
 * Scope is "what an attachment realistically arrives as": office documents,
 * the plain-text family, and the audio/image/video types whose subtype is a
 * famous mismatch (`audio/mpeg` is mp3, `image/jpeg` is jpg). Deliberately NOT
 * covered, because the generic fallback already answers them or because no
 * answer is better than a guessed one: archive and compression formats beyond
 * their own subtype, `application/x-*` experimental types, and unregistered
 * vendor types outside the office suites.
 *
 * A `Map` rather than an object literal, for the reason spelled out on
 * {@link AGUI_MEDIA_TYPES}: the key is a client-supplied MIME string, and an
 * object literal answers `"constructor"` with an inherited function.
 */
const FILENAME_EXTENSIONS = new Map<string, string>([
  // Text
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/x-markdown", "md"],
  ["text/rtf", "rtf"],
  ["application/rtf", "rtf"],
  ["text/xml", "xml"],
  ["application/xml", "xml"],
  // Office
  ["application/msword", "doc"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.ms-powerpoint", "ppt"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx",
  ],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  // The canonical "unknown bytes" type, and the generic fallback's answer too.
  ["application/octet-stream", "bin"],
  // Audio. Reachable here only via a document item carrying an audio MIME type
  // — the audio path emits an `audio` block, which needs no filename — but the
  // two derivations must not disagree about what `audio/mpeg` is called.
  ["audio/mpeg", "mp3"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/vnd.wave", "wav"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  // Image / video, same "mislabelled document" reachability.
  ["image/jpeg", "jpg"],
  ["image/svg+xml", "svg"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["video/quicktime", "mov"],
  ["video/x-msvideo", "avi"],
  ["video/x-matroska", "mkv"],
]);

/** An extension a filename can plausibly end in: short and alphanumeric. */
const PLAUSIBLE_EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * A filename for a `file` block whose AG-UI item did not carry one.
 *
 * Not cosmetic. `@langchain/openai` THROWS on a file block with no filename
 * ("a filename or name or title is needed via meta-data for OpenAI when working
 * with multimodal blocks" — measured 2026-08-25 on `@langchain/openai@1.2.0`), so
 * the document path this converter claims to support has to carry one or it is
 * not actually supported.
 *
 * Python does not throw, and does not merely drop the key either: measured on
 * `langchain-core@1.2.13`, a nameless file block warns ("OpenAI may require a
 * filename for file uploads…") and the part goes out carrying the PLACEHOLDER
 * `filename: "LC_AUTOGENERATED"` — i.e. the provider is told the user attached a
 * file by that name. Substituting a derived name is an improvement on both.
 *
 * The two runtimes do NOT emit the same block: this one emits
 * `source_type` / `data` / `mime_type` / `metadata.filename`, the Python adapter
 * emits `base64` / `mime_type` / top-level `filename`. Both run the same
 * derivation — `_derive_filename` there is kept identical to this — so an
 * attachment gets the same name whichever runtime sent it.
 *
 * THE TWO BLOCKS ARE NOT INTERCHANGEABLE. An earlier revision of this paragraph
 * said they were — "both translate to the same provider part (verified through
 * both real translators)" — and only three of the four combinations hold.
 * Measured 2026-08-25 with an `application/pdf` file block, on
 * `@langchain/openai@1.2.0` + `@langchain/core@1.1.40` (through `ChatOpenAI` with
 * a stub `fetch`) and `langchain-core@1.2.13` (through
 * `convert_to_openai_messages`):
 *
 *   block emitted by   JS translator            Python translator
 *   -----------------  -----------------------  -----------------------
 *   this adapter       file.file_data ✓         file.file_data ✓
 *                      + file.filename          + file.filename
 *   the Python adapter FORWARDED VERBATIM ✗     file.file_data ✓
 *                      (reaches the provider    + file.filename
 *                      as `{"type": "file",
 *                      "base64": …, "mime_type":
 *                      …, "filename": …}`, with
 *                      no throw and no warning)
 *
 * The failing cell is the direction that does not occur. JS gates translation on
 * `isDataContentBlock`, which tests `source_type` and nothing else, and the
 * Python adapter never emits that key — the same trap {@link StandardMediaBlock}
 * documents for the JS-native shape. It stays LATENT because neither adapter's
 * output crosses into the other's translator, and for asymmetric reasons:
 *
 *   - This package drives a LangGraph SERVER over `@langchain/langgraph-sdk`,
 *     and that server is usually the Python one. Its blocks therefore have to
 *     translate in BOTH columns — which is exactly why row 1 is measured in both
 *     and why {@link StandardMediaBlock} picks the shape it picks.
 *   - The Python adapter's `LangGraphAgent` takes an IN-PROCESS
 *     `CompiledStateGraph`, not a remote deployment, so a block it emits is only
 *     ever handed to langchain-core Python — row 2's ✓ cell. Nothing in either
 *     package routes row 2 into the JS column.
 *
 * So the surviving claim is the narrower one: each block produces the same
 * provider part through the translator its own runtime actually reaches, and
 * this adapter's block additionally survives the other runtime's. Revisit if the
 * Python adapter ever grows a remote-server transport.
 *
 * THE SUBTYPE IS NOT THE EXTENSION. It coincides with one often enough to look
 * like a rule — `application/pdf`, `text/csv` — and then does not:
 * `text/plain` is not `.plain`, `audio/mpeg` is not `.mpeg`, and
 * `application/vnd.api+json` is not `.vnd.api`. So the subtype is a LAST resort
 * here, taken only when it survives being checked:
 *
 *   1. {@link FILENAME_EXTENSIONS} answers the types whose subtype is wrong.
 *   2. A structured-syntax suffix (RFC 6838 §4.2.8) names the underlying
 *      format, so `+json` / `+xml` wins over the vendor tree in front of it.
 *   3. Otherwise the registration-tree prefix (`vnd.`, `prs.`, `x-`, `x.`) is
 *      stripped, because it is a namespace and not part of any extension.
 *   4. What is left has to LOOK like an extension. `ms-excel` and
 *      `openxmlformats-officedocument.wordprocessingml.document` do not, and a
 *      dot inside the "extension" turns `attachment.vnd.ms-excel` into a file
 *      apparently named `attachment.vnd`. Anything implausible becomes `.bin`,
 *      which is what an unidentified byte stream is called.
 *
 * MIME types are case-insensitive (RFC 2045 §5.1), so the lookup is case-folded.
 */
function deriveFilename(mimeType: string | undefined): string {
  // NO non-string guard here, unlike {@link normalizedAudioMimeType}, and that is
  // load-bearing rather than an oversight: `string | undefined` is ENFORCED for
  // every caller by the two functions that resolve a MIME type before this one
  // is reached — {@link standardBlockTypeFor} substitutes for an unusable one and
  // {@link readIncomingMediaBlock} reads it through {@link firstNonEmptyString}.
  // Python's `_derive_filename` is guarded by the same two (`_standard_block_for`,
  // `_read_incoming_media_block`), so the pair agrees. Widen this signature and
  // the guard has to come with it.
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();

  let extension = FILENAME_EXTENSIONS.get(base);
  if (!extension) {
    // Everything after the FIRST slash, not `split("/")[1]`. A malformed
    // `a/b/c` has no subtype, and taking the middle segment would invent one —
    // and invent a different one than Python's `partition("/")`, which is the
    // divergence this file exists to avoid.
    const slash = base.indexOf("/");
    let subtype = slash < 0 ? "" : base.slice(slash + 1);
    const plus = subtype.lastIndexOf("+");
    if (plus >= 0) {
      subtype = subtype.slice(plus + 1);
    } else {
      subtype = subtype.replace(/^(?:vnd\.|prs\.|x-|x\.)/, "");
    }
    extension = PLAUSIBLE_EXTENSION.test(subtype) ? subtype : "bin";
  }

  return `attachment.${extension}`;
}

/**
 * The return leg: which AG-UI media type a standard block becomes.
 *
 * A `Map` rather than an object literal — the same prototype-key immunity
 * {@link MEDIA_CONTENT_TYPES} gets from being a `Set`, in the form that also
 * carries a value. The key is `item.type` off an inbound block, which is
 * whatever the LangGraph server relayed from model or tool output and is not
 * author-controlled. An object literal answers `["constructor"]` or
 * `["toString"]` with an inherited `Object.prototype` member — truthy, and a
 * function — so a block typed after a prototype key would pass the gate and be
 * emitted with a FUNCTION as its AG-UI content type, failing schema validation
 * downstream. A `Map` sees only what was put in it, and `get` returns the media
 * type in the same lookup that decides the branch.
 */
const AGUI_MEDIA_TYPES = new Map<
  string,
  "audio" | "video" | "document" | "image"
>([
  ["audio", "audio"],
  ["video", "video"],
  ["file", "document"],
  ["image", "image"],
]);

/**
 * The AG-UI media type named by a MIME type's MAJOR part.
 *
 * Used only on the `image_url` return leg, where the block kind says "image" for
 * every modality and the MIME type inside the data URL is the one remaining
 * modality signal. A `Map` for the same reason as {@link AGUI_MEDIA_TYPES}: the
 * key comes off the wire.
 *
 * Kept in lockstep with `_MEDIA_TYPES_BY_MIME_MAJOR` in the Python adapter.
 */
const MEDIA_TYPES_BY_MIME_MAJOR = new Map<string, "audio" | "video" | "image">([
  ["image", "image"],
  ["audio", "audio"],
  ["video", "video"],
]);

/** Recover modality from legacy image_url data URLs; opaque URLs remain images. */
function aguiMediaTypeForMimeType(
  mimeType: string,
): "audio" | "video" | "document" | "image" {
  const [major, subtype] = mimeType.split("/");
  // A string that is not `major/subtype` carries no modality; keep the historical
  // answer rather than inventing a new wrong one.
  if (!major || !subtype) return "image";
  return (
    MEDIA_TYPES_BY_MIME_MAJOR.get(major.trim().toLowerCase()) ?? "document"
  );
}

/**
 * The media block this adapter emits: a LangChain `source_type` data block.
 *
 * THIS IS THE ONLY REPRESENTATION THAT TRANSLATES IN BOTH RUNTIMES, and this
 * adapter needs both — it is a JavaScript package that talks to a LangGraph
 * server which is usually the Python one. Measured 2026-08-25 against the locked
 * dependencies — `@langchain/core@1.1.40` + `@langchain/openai@1.2.0` through
 * `ChatOpenAI` with a stub `fetch`, and `langchain-core@1.2.13` through
 * `convert_to_openai_messages` — reading the request body each one produced:
 *
 *   shape                                    JS default path      Python
 *   ---------------------------------------  -------------------  ----------------
 *   source_type + data + mime_type           file.file_data ✓     file.file_data ✓
 *   Python native (base64/mime_type)         VERBATIM ✗           file.file_data ✓
 *   JS native (data/mimeType/metadata)       VERBATIM ✗           VERBATIM ✗
 *
 * "VERBATIM" is the trap. The block is neither translated nor rejected: it is
 * forwarded to the provider exactly as written, so the request carries a content
 * part the API does not accept. It is the failure mode in BOTH runtimes for a
 * shape that runtime does not recognise — the JS-native block came back out of
 * `convert_to_openai_messages` as `{"type": "file", "data": …, "mimeType": …,
 * "metadata": {…}}`, unchanged, with no exception and no warning. (An earlier
 * revision of this table claimed Python raised a `ValueError` on that row. It
 * does not, on 1.2.13 — silence is the actual behaviour, and it is worse.)
 *
 * On the JS side the cause is that the default conversion path gates translation
 * behind `isDataContentBlock`, which requires a `source_type` of `"url"` /
 * `"base64"` / `"text"` / `"id"`; a block without that key is not recognised as
 * media at all.
 *
 * `@langchain/core` does mark this family `@deprecated` ("Use
 * {@link ContentBlock.Multimodal.Data} instead" — the literal JSDoc in
 * `dist/messages/content/data.d.ts`), and the JS-native shape it points to
 * works — but ONLY on the v1 conversion path, which requires
 * `response_metadata.output_version === "v1"` on the message. This adapter does
 * not set that marker and cannot set it for a graph it does not own, so on the
 * path that actually runs, the non-deprecated shape is the one that silently
 * fails. The deprecated family costs nothing for staying: measured, it translates
 * to `file.file_data` on the v1 path too. Deprecated-and-translated beats
 * current-and-forwarded-raw.
 *
 * KNOWN LIMIT, measured and deliberately not addressed here: the Responses API.
 * Everything above is Chat Completions, which is where the reported failure was.
 * On `useResponsesApi: true` the same emitted block behaves differently, and no
 * single shape fixes both — the JS-native shape is correct on Responses/v1 and
 * forwarded raw on the Chat Completions default path, which is the bug this
 * change exists to fix. Measured 2026-08-25 on `@langchain/openai@1.2.0`, before
 * and after, reading the request body off a stub `fetch`:
 *
 *   case                          before                     after
 *   ----------------------------  -------------------------  ----------------------
 *   audio, Responses, v1          input_image (wrong kind)   NO PART EMITTED
 *   audio, Responses, default     input_image (wrong kind)   input_audio ✓
 *   audio, Completions, either    image_url (wrong kind)     input_audio ✓
 *   document, Responses, v1       input_image (wrong kind)   input_file ✓
 *   document, Responses, default  input_image (wrong kind)   file.file_data
 *                                                            (Chat Completions
 *                                                            part shape; the
 *                                                            Responses form is
 *                                                            input_file)
 *
 * Note row 3's "before": on Chat Completions the old `image_url` block stayed an
 * `image_url` part. `input_image` is the RESPONSES spelling of the same mistake,
 * so only the Responses rows show it.
 *
 * Row 3 is two cases (default and v1), so the table covers six. Five of them go
 * from a wrong-kind part to a right-kind one. Row 1 goes the other way, and it is
 * the one to know about: the attachment stops being emitted at all, with no throw
 * and no warning, so the model answers without ever seeing it. The cause is
 * upstream and not reachable from here — `dist/converters/responses.js` handles
 * the v1 block kinds in one chain and audio's branch is empty
 * (`} else if (block.type === "audio") {}`), the only occurrence of "audio"
 * anywhere in that converter, sitting immediately before the `file`, `image` and
 * `video` branches, each of which resolves a real part.
 *
 * Note what row 1 is NOT: a working path that this change broke. Before, the
 * audio went out labelled as an image, so the request carried a part the API
 * does not accept for audio. The run failed then and produces a wrong answer now
 * — worse to diagnose, but not a lost capability.
 *
 * This converter cannot tell the two transports apart. It receives messages and
 * nothing else; the model is constructed inside the graph, on the far side of the
 * LangGraph server call. Emitting per-transport is not possible from here.
 *
 * Revisit when the JS default path translates native blocks without a marker, or
 * when the Responses v1 converter grows an audio branch. Neither has happened as
 * of `@langchain/openai@1.2.0` / `@langchain/core@1.1.40`, re-checked 2026-08-25:
 * a native block is still forwarded raw on the default path, and the audio branch
 * in `dist/converters/responses.js` is still empty.
 */
interface StandardMediaBlock {
  type: "audio" | "video" | "file";
  /**
   * The recognition key. `@langchain/core`'s `isDataContentBlock` gate tests for
   * `source_type` and nothing else, so a block without it is not seen as media.
   */
  source_type: "base64" | "url";
  /** Base64 payload or an opaque URL reference. */
  data?: string;
  url?: string;
  mime_type?: string;
  /**
   * `filename` lives under `metadata` rather than at the top level, because that
   * is where both runtimes look — JS via `getRequiredFilenameFromMetadata`,
   * Python via `convert_to_openai_data_block`'s backward-compat branch. JS THROWS
   * when it cannot find one on a file block, which is why the document path never
   * emits without it (see {@link deriveFilename}).
   */
  metadata?: { filename?: string };
}

/** A LangChain content block as this adapter emits it. */
type LangchainContentBlock =
  | { type: "text"; text?: string }
  | { type: "image_url"; image_url: { url: string } }
  | StandardMediaBlock;

/**
 * The `image_url` URL for an AG-UI media source, or `null` if there isn't one.
 *
 * `source` is typed as required but arrives off the wire, so it is read
 * OPTIONALLY. A media item with no source at all is not a type error the caller
 * can rule out — {@link standardBlockTypeFor} already reads the same field as
 * `source?.type`, and the two paths must not disagree about whether it can be
 * absent. More importantly, this runs inside the loop that converts a whole
 * message list: a throw here discards every other block and every other message,
 * where the Python adapter's `isinstance` chain simply returns `None` and lets
 * the caller warn and drop the one bad item. Returning `null` is what keeps the
 * two runtimes degrading the same way.
 *
 * THE PAYLOAD IS READ THROUGH {@link firstNonEmptyString} ON BOTH SOURCE KINDS,
 * for the same reason the MIME type beside it already is. `value` is declared
 * `string` and nothing enforces that here:
 *
 *   * a `data` source carrying `null` / `42` / `""` interpolated STRAIGHT INTO
 *     the data URL — `data:image/png;base64,null` is a payload the provider will
 *     try to decode, and the empty-payload spelling `data:image/png;base64,` is
 *     the exact string {@link parseBase64DataUrl} refuses to read back as bytes,
 *     so the attachment was already unreadable by this adapter's own rule;
 *   * a `url` source carrying a non-string was returned VERBATIM, putting a
 *     number or an object under `image_url.url` on the provider request. That
 *     one also DIVERGED: `{}` is truthy here and falsy in Python, so the same
 *     item was kept by one runtime and dropped by the other.
 *
 * Both collapse onto `null`, which is the one thing the caller already knows how
 * to announce.
 */
function mediaSourceToUrl(
  source: PartSource | null | undefined,
): string | null {
  if (source?.type === "data") {
    // `mimeType` is declared required, but this source arrives off the wire and
    // nothing validates it at this boundary, so it can be absent as easily as
    // empty — and template interpolation renders an absent one as the literal
    // text `undefined`, putting `data:undefined;base64,…` on the provider
    // request and, on the return leg, the string `"undefined"` into the thread's
    // `mimeType` PERMANENTLY. Both spellings of "no MIME type" collapse to the
    // one the data URL grammar already has for it: an omitted mediatype.
    //
    // Deliberately NOT the `application/octet-stream` that
    // {@link standardBlockTypeFor} substitutes for a document. This is the
    // image_url path; {@link aguiMediaTypeForMimeType} reads the MIME type
    // inside this very URL to recover that modality: `application/octet-stream`
    // reads back as a DOCUMENT, so substituting it here would silently retype a
    // MIME-less image as a document on the next MESSAGES_SNAPSHOT. An omitted
    // mediatype reads back as an image, which is what the item already was.
    const value = firstNonEmptyString(source.value);
    if (!value) return null;
    return `data:${firstNonEmptyString(source.mimeType) ?? ""};base64,${value}`;
  } else if (source?.type === "url") {
    return firstNonEmptyString(source.value) ?? null;
  }
  // A `file` source lands here. Its `value` is a provider-issued HANDLE, not a
  // URL — emitting it under `image_url.url` would put an opaque token on the
  // provider request — so it collapses onto the same `null` the caller already
  // knows how to announce, and the one part is dropped with the one warning.
  return null;
}

/**
 * The attachment's original filename, if the client sent one.
 *
 * `metadata: { filename }` is the established AG-UI carrier for it — the client's
 * own `backward-compatibility-0-0-47` middleware migrates the legacy
 * `BinaryInputContent.filename` into exactly that shape. Note this reads ONE key
 * out of metadata rather than copying the object: a top-level `metadata` key on
 * the block itself is what issue #2100 was about, and `filename` is a documented
 * field of the block.
 */
function filenameFromMetadata(metadata: unknown): string | undefined {
  if (metadata && typeof metadata === "object") {
    return firstNonEmptyString((metadata as { filename?: unknown }).filename);
  }
  return undefined;
}

/**
 * The first candidate that is a usable filename, or `undefined`.
 *
 * "Usable" excludes the EMPTY STRING as well as null/undefined and non-strings.
 * A supplied-but-empty filename is not a name the client chose, it is a name the
 * client failed to send, and treating it as a value is what makes a `??` chain
 * shadow the fallback behind it — the divergence from Python this consolidates
 * away. Every caller reads keys that arrive off the wire, so the type check is
 * not redundant with the declared types.
 */
function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

/**
 * A short, safe name for the RUNTIME TYPE of an off-the-wire value, for the
 * "Dropping …" logs rule 2 of the malformed-input contract requires.
 *
 * `typeof null` is `"object"` and `typeof []` is `"object"`, and both of those
 * arrive here — an operator reading "no usable url in its object payload" for a
 * JSON `null` learns nothing. Names the same distinctions Python's
 * `type(x).__name__` does in the mirrored log lines.
 */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Emit standard inline media, retaining supplied filenames and deriving file names. */
function standardMediaBlock(
  type: StandardMediaBlock["type"],
  data: string,
  mimeType: string | undefined,
  filename?: string,
  sourceType: "base64" | "url" = "base64",
): StandardMediaBlock {
  const block: StandardMediaBlock = {
    type,
    source_type: sourceType,
    ...(sourceType === "base64" ? { data } : { url: data }),
    ...(mimeType ? { mime_type: mimeType } : {}),
  };
  // `||`, not `??`. A supplied filename arrives off the wire and can be the
  // EMPTY STRING; `??` would accept it, skip the fallback, and then fail the
  // `if (name)` below — emitting a file block with no filename at all, which is
  // the one thing `@langchain/openai` throws on. An empty name is an absent
  // name. Python's `_standard_media_block` reads it the same way.
  const name =
    filename ||
    (type === "file" && sourceType === "base64"
      ? deriveFilename(mimeType)
      : undefined);
  if (name) block.metadata = { filename: name };
  return block;
}

/**
 * A media block on the way BACK from LangChain, in any of the three shapes this
 * adapter can legitimately receive. See {@link readIncomingMediaBlock}.
 */
interface IncomingMediaBlock {
  type: string;
  text?: string;
  image_url?: any;
  // Native LangChain.js (`ContentBlock.Multimodal.Data`).
  data?: string;
  mimeType?: string;
  fileId?: string;
  metadata?: { filename?: string; name?: string; title?: string };
  url?: string;
  // LangChain Python, and the deprecated JS `source_type` family.
  base64?: string;
  mime_type?: string;
  filename?: string;
  source_type?: string;
}

/**
 * Normalize an incoming media block to `{ value, isUrl, mimeType, filename }`.
 *
 * DELIBERATELY ACCEPTS THREE SHAPES, which is the "intentional cross-runtime
 * representation" half of this converter:
 *
 *   1. native LangChain.js — `data` / `url` / `fileId`, `mimeType`,
 *      `metadata.filename`: `@langchain/core`'s `ContentBlock.Multimodal.Data`.
 *      NOT what this adapter emits — see {@link StandardMediaBlock}, which emits
 *      shape (3) precisely BECAUSE this shape is forwarded raw on the JS default
 *      conversion path. It is accepted here because a JS-side graph that builds
 *      its own content can legitimately produce it.
 *   2. LangChain Python — `base64` / `url`, `mime_type`, `filename`. NOT
 *      hypothetical: this package drives a LangGraph server through
 *      `@langchain/langgraph-sdk`, and that server is usually the Python one, so
 *      a graph's own messages come back in Python's shape. Refusing them here
 *      would reproduce the exact bug this file is fixing, mirrored — the
 *      attachment would vanish from `MESSAGES_SNAPSHOT` instead of from the
 *      provider request.
 *   3. the deprecated JS `source_type` family, still accepted by
 *      `@langchain/core`'s legacy conversion path and therefore still in the
 *      wild.
 *
 * Being liberal inbound and strict outbound is the whole point: one wire shape
 * leaves this adapter, three can arrive.
 */
function readIncomingMediaBlock(item: IncomingMediaBlock): {
  value: string;
  isUrl: boolean;
  mimeType?: string;
  filename?: string;
} | null {
  // A SCAN FOR THE FIRST NON-EMPTY STRING, not a `??` chain. `??` falls through
  // on null/undefined only, so `metadata: { filename: "", name: "report.pdf" }`
  // would stop at the empty string and throw away the name `metadata.name` was
  // carrying. Every one of these keys arrives off the wire, so a non-string is
  // possible too and is no more usable than an empty one. Mirrors Python's
  // `_incoming_block_filename`, which already read it this way.
  const filename = firstNonEmptyString(
    item.metadata?.filename,
    item.metadata?.name,
    item.metadata?.title,
    item.filename,
  );
  // Same scan, same reason. `??` stops on a present-but-empty `mimeType` and
  // throws away the `mime_type` behind it — the Python-shaped key that a Python
  // LangGraph server actually sends — so a block carrying BOTH keys would lose
  // its real MIME type and arrive as `application/octet-stream`. Python's
  // reader already scans for the first non-empty string here; this is the line
  // that made the two runtimes disagree about the same inbound block.
  const mimeType = firstNonEmptyString(item.mimeType, item.mime_type);
  // And again for the payload: `data: ""` alongside a populated `base64` is the
  // same cross-shape collision, and `??` would stop at the empty string, fall
  // past both return branches below, and DROP THE WHOLE BLOCK. Python reads it
  // with `or`, which falls through.
  const inlineData = firstNonEmptyString(item.data, item.base64);
  // `url` is read through the same helper rather than a `typeof` check, so the
  // non-string case is rejected in the same place as the empty one.
  const url = firstNonEmptyString(item.url);

  if (inlineData) {
    return { value: inlineData, isUrl: false, mimeType, filename };
  }
  if (url) {
    // A `data:` URL is url-SHAPED but it is not a reference: RFC 2397 puts the
    // bytes in the string. Recording it as an AG-UI URL SOURCE writes a claim
    // into the thread that the attachment lives somewhere else, and the outbound
    // leg then believes it — a PDF stored this way went back out as `image_url`,
    // the exact provider failure the standard-block path exists to prevent.
    // Normalizing here rather than only outbound means the THREAD is right too,
    // which is what `MESSAGES_SNAPSHOT` shows the client and what `flatten`
    // and every other reader of AG-UI content sees.
    //
    // The MIME type inside the data URL wins over the block's declared one, for
    // the reason {@link inlineMediaData} gives; a data URL with an omitted
    // mediatype falls back to the block's.
    //
    // A REMOTE url, and a data URL this cannot read as inline bytes (no
    // `;base64`, no comma, empty payload — see {@link parseBase64DataUrl}), stay
    // url sources exactly as before.
    const dataUrl = parseBase64DataUrl(url);
    if (dataUrl) {
      return {
        value: dataUrl.data,
        isUrl: false,
        mimeType: dataUrl.mimeType ?? mimeType,
        filename,
      };
    }
    return { value: url, isUrl: true, mimeType, filename };
  }
  // `fileId`-only blocks reference provider-side storage with no bytes and no
  // URL, and AG-UI's typed content classes have nowhere to put that.
  return null;
}

/**
 * An inbound filename, unless this adapter is the one that made it up.
 *
 * {@link deriveFilename} fabricates a name for every filename-less document on
 * the way out, because the provider translator throws without one. That name
 * comes back on the return leg, and writing it into AG-UI `metadata.filename`
 * would make an invented name INDISTINGUISHABLE from one the user typed — the
 * thread would then assert, permanently, that the user attached a file called
 * `attachment.pdf`. It also freezes the guess: a supplied name always wins over
 * derivation, so once the fabricated one is in the thread, every later send
 * keeps it even after the derivation is corrected.
 *
 * There is no marker to test, and a marker on the wire would be a marker in the
 * provider request. What there is instead is determinism: the fabricated name is
 * exactly `deriveFilename(mime_type)` and nothing else ever is, so recomputing it
 * identifies it. A user who genuinely named their PDF `attachment.pdf` loses
 * nothing that reaches a provider — the outbound leg derives that same string
 * back for them on the next send.
 *
 * Only `file` blocks are checked, because only `file` blocks are ever given a
 * derived name.
 */
function suppliedFilename(
  blockType: string,
  filename: string | undefined,
  mimeType: string | undefined,
): string | undefined {
  if (!filename) return undefined;
  if (blockType === "file" && filename === deriveFilename(mimeType))
    return undefined;
  return filename;
}

/**
 * The url carried by a legacy `image_url` block, or `undefined` if it has none.
 *
 * The payload is whatever the graph put under the `image_url` key. Two shapes
 * carry a url: LangChain's own `{ url: "…" }` and the bare string both runtimes
 * also accept. EVERYTHING else — `null`, a number, an array, an object with no
 * `url` or a non-string/empty one — carries no url at all, and the caller drops
 * the block rather than deriving one.
 *
 * Reading it defensively is the point, and it is rule 1 of the malformed-input
 * contract documented below: the caller builds the user message inside
 * MESSAGES_SNAPSHOT, so `payload.url.startsWith(...)` on a NUMERIC url does not
 * lose one block, it throws out of the whole snapshot and loses the ENTIRE
 * thread. And a payload that yields `""` is no better for being quiet: it mints
 * an attachment pointing at nothing.
 *
 * Mirrors Python's `_incoming_image_url`, which already read it this way.
 */
function incomingImageUrl(payload: unknown): string | undefined {
  const url =
    typeof payload === "string"
      ? payload
      : payload !== null && typeof payload === "object"
        ? firstNonEmptyString((payload as { url?: unknown }).url)
        : undefined;
  if (url === undefined) return undefined;
  // TRIMMED, because whitespace is the side door into the empty-value defect
  // this function already rejects. A url of `"   "` is truthy, so the checks
  // above let it through to mint an attachment pointing at nothing, and a
  // LEADING space on `"  data:image/png;base64,…"` is worse than that: the
  // caller's `startsWith("data:")` says false, so a base64 payload is filed as
  // a remote url the client then tries to fetch. Mirrors Python's
  // `_incoming_image_url`.
  return url.trim() || undefined;
}

/**
 * THE MALFORMED-INPUT CONTRACT for the two content converters below.
 *
 * Both directions read arrays that nothing validated at this boundary —
 * LangGraph relays whatever the graph put in a message, and the AG-UI side is
 * client JSON that TypeScript's types describe but never enforce — so every
 * field reachable from here can be absent, empty, or of the wrong type. Three
 * rules, and they hold for BOTH converters in BOTH runtimes:
 *
 *   1. DROP, NEVER RAISE. An item this converter cannot make sense of is
 *      skipped. Nothing in either converter throws on its input. These
 *      functions build a whole MESSAGES_SNAPSHOT / a whole provider request, so
 *      an exception does not degrade one attachment — it escapes the loop and
 *      costs the client every message in the thread.
 *   2. EVERY DROP IS LOGGED, once, at warning level, in a message beginning
 *      `Dropping `. A vanished attachment with no string to search for is the
 *      failure an operator cannot diagnose. This covers the drops that have no
 *      branch of their own: an item of an UNRECOGNISED TYPE is a drop too, and
 *      says so.
 *   3. ONE BAD ITEM COSTS ONLY ITSELF. The items on either side of it in the
 *      same content array, and every other message in the list, still convert.
 *
 * All three are checkable from outside: for ANY input, each converter returns an
 * array, emits one warning per dropped item, and the surviving items are exactly
 * what the same input minus the bad item would have produced.
 *
 * The Python adapter carries this same block above
 * `convert_langchain_multimodal_to_agui`. The two must not drift.
 */

/**
 * Convert LangChain's multimodal content to AG-UI format.
 *
 * Malformed input is handled per THE MALFORMED-INPUT CONTRACT, the comment block
 * immediately above this one.
 *
 * `image_url` blocks are converted with the appropriate source type (data or URL)
 * and to the media type their MIME type names for historical non-image blocks.
 * See {@link aguiMediaTypeForMimeType}. LangChain's
 * standard media blocks (`image` /
 * `audio` / `video` / `file`) are converted back to the matching AG-UI content
 * type, which is what keeps a non-image attachment in the thread across a
 * MESSAGES_SNAPSHOT — a block kind missing here is an attachment that vanishes
 * from a reopened thread.
 */
function convertLangchainMultimodalToAgui(
  content: (IncomingMediaBlock | string)[],
): InputContent[] {
  const aguiContent: InputContent[] = [];

  for (const item of content) {
    // A plain string entry is CONTENT, not a malformed block. LangChain types
    // message content as `str | list[str | dict]` and folds a bare entry in as
    // text — `convert_to_openai_messages(["hello", {type: "text", text: " world"}])`
    // sends the model `"hello\n world"` — so dropping it loses the user's own
    // words rather than discarding junk. Mirrors the `isinstance(item, str)`
    // branch in the Python adapter.
    if (typeof item === "string") {
      aguiContent.push({
        type: "text",
        text: item,
      });
      continue;
    }

    // A content array relayed by the LangGraph server can carry a JSON `null`, a
    // number, or a nested array where a block is expected, and `item.type` on one
    // of those aborts the conversion of every OTHER block and every other message.
    // One unusable block is dropped like any other unusable block.
    if (!item || typeof item !== "object") {
      console.warn(
        "[convertLangchainMultimodalToAgui] Dropping content block: not an object",
      );
      continue;
    }

    // Resolved before the chain so the branch gate and the emitted content type
    // are one lookup rather than two. `undefined` for every block kind this
    // converter does not recognise, prototype key or not.
    const type = AGUI_MEDIA_TYPES.get(item.type);

    if (item.type === "text") {
      // `text` was previously gated on TRUTHINESS, which got both ends wrong: a
      // non-string truthy `text` (a number, an object) was emitted verbatim into
      // `TextInputContent.text` and failed schema validation downstream, and a
      // present-but-empty one was dropped with no log at all — a rule-2
      // violation on a block Python keeps. An ABSENT `text` is the empty string
      // (Python reads it as `item.get("text", "")`); a present non-string one is
      // unusable and is dropped like any other unusable item.
      const text = item.text === undefined ? "" : item.text;
      if (typeof text !== "string") {
        console.warn(
          `[convertLangchainMultimodalToAgui] Dropping text block: text is ${text === null ? "null" : typeof text}, not a string`,
        );
        continue;
      }
      aguiContent.push({
        type: "text",
        text,
      });
    } else if (type) {
      const incoming = readIncomingMediaBlock(item);

      if (!incoming) {
        console.warn(
          `[convertLangchainMultimodalToAgui] Dropping ${item.type} block: no data, base64 or url to carry back`,
        );
        continue;
      }

      const filename = incoming.isUrl
        ? incoming.filename
        : suppliedFilename(item.type, incoming.filename, incoming.mimeType);
      const metadata = filename ? { filename } : undefined;

      if (incoming.isUrl) {
        aguiContent.push({
          type,
          source: {
            type: "url",
            value: incoming.value,
            ...(incoming.mimeType ? { mimeType: incoming.mimeType } : {}),
          },
          ...(metadata ? { metadata } : {}),
        } as InputContent);
      } else {
        aguiContent.push({
          type,
          source: {
            type: "data",
            value: incoming.value,
            // A base64 block with no MIME type is malformed rather than merely
            // terse, but an AG-UI data source REQUIRES one, so fall back to the
            // least wrong thing instead of dropping the attachment.
            mimeType: incoming.mimeType || "application/octet-stream",
          },
          ...(metadata ? { metadata } : {}),
        } as InputContent);
      }
    } else if (item.type === "image_url") {
      // Historical image_url data URLs may contain non-image media.
      // Read through {@link incomingImageUrl}, not `item.image_url?.url`: the
      // raw read accepts a NON-STRING truthy url — `{ url: 42 }` off the wire —
      // and `imageUrl.startsWith("data:")` on the next line then threw a
      // TypeError out of the entire message-list conversion.
      const imageUrl = incomingImageUrl(item.image_url);

      if (!imageUrl) {
        console.warn(
          `[convertLangchainMultimodalToAgui] Dropping image_url block: no usable url in its ${describeType(item.image_url)} payload`,
        );
        continue;
      }

      // Parse data URLs to extract base64 data
      if (imageUrl.startsWith("data:")) {
        // Format: data:mime_type;base64,data
        //
        // Split on the FIRST comma and keep everything after it, rather than
        // `split(",", 2)`, which keeps only the segment BETWEEN the first and
        // second commas and silently truncates the payload of a `data:` URL
        // carrying more than one. Base64 has no commas so no well-formed
        // attachment changes, but Python reads it with `split(",", 1)` and kept
        // the whole remainder — a divergence on exactly this line.
        const comma = imageUrl.indexOf(",");
        const header = comma < 0 ? imageUrl : imageUrl.slice(0, comma);
        const data = comma < 0 ? "" : imageUrl.slice(comma + 1);

        // Rule 1 and rule 2 of the malformed-input contract. A `data:` URL with
        // no comma at all (`data:image/png;base64`) or nothing after it
        // (`data:image/png;base64,`) has no payload, and the branch below would
        // mint an AG-UI attachment whose `value` is the EMPTY STRING — a content
        // item pointing at nothing, written into the thread and read back on
        // every later open. That is the same defect {@link incomingImageUrl}
        // rejects one level up for a payload that yields `""`, and the same one
        // {@link readIncomingMediaBlock} already rejects on the standard-block
        // path, where an empty `data`/`base64` drops the block. This branch was
        // the one place that kept it.
        // No `.trim()` here, deliberately: {@link incomingImageUrl} already
        // trimmed the whole url, so a payload that is nothing but whitespace
        // has ALREADY become the empty string by the time it reaches this
        // guard. A payload with INTERNAL whitespace keeps it, which is correct
        // — MIME-wrapped base64 legitimately carries newlines and both atob and
        // Python's b64decode ignore them.
        if (!data) {
          console.warn(
            "[convertLangchainMultimodalToAgui] Dropping image_url block: data URL carries no payload",
          );
          continue;
        }
        // `|| "image/png"`, not just the `includes(":")` gate. A `data:` URL
        // ALWAYS has a colon, so the gate never falls through for one — but the
        // mediatype it then extracts is the empty string for the `data:;base64,…`
        // that a MIME-less attachment produces. The gate therefore treated
        // "present but empty" as a value and wrote `mimeType: ""` into the
        // thread, while the comment on {@link aguiMediaTypeForMimeType} claimed
        // the `image/png` default applied to exactly this case. Now it does.
        // The MEDIA TYPE is unaffected either way — `aguiMediaTypeForMimeType`
        // answers "image" for both `""` and `image/png` — so this only stops an
        // unusable MIME type from being recorded, it does not retype anything.
        // A BLANK mediatype (`data:   ;base64,…`) is "present but empty" wearing
        // whitespace, and unusable for the same reason the empty one is. Only a
        // blank one collapses — a padded but REAL mediatype keeps its padding,
        // which the parity table pins on both runtimes.
        const rawMimeType = header.includes(":")
          ? header.split(":")[1].split(";")[0]
          : "";
        const mimeType = (rawMimeType.trim() ? rawMimeType : "") || "image/png";

        aguiContent.push({
          // The MIME type this adapter put in the data URL on the way out is
          // enough to recover the modality on the way back.
          type: aguiMediaTypeForMimeType(mimeType),
          source: {
            type: "data",
            value: data,
            mimeType,
          },
        } as InputContent);
      } else {
        // Regular URL. Nothing here names a modality — this is the first of the
        // two unrecoverable cases in {@link aguiMediaTypeForMimeType} — so it
        // stays an image.
        aguiContent.push({
          type: "image",
          source: {
            type: "url",
            value: imageUrl,
          },
        });
      }
    } else {
      // Rule 2 of the malformed-input contract. A block matching NO branch used
      // to fall out of the loop leaving nothing behind — no content item and no
      // log — while every other drop in this same loop says so. That is the drop
      // most worth announcing: the others lost one field of a recognized block,
      // this one loses the attachment whole, and an operator watching a file
      // vanish from a reopened thread had no string to search for. A block kind
      // LangChain adds later lands here.
      console.warn(
        `[convertLangchainMultimodalToAgui] Dropping unsupported content block of type ${JSON.stringify(item.type)}`,
      );
    }
  }

  return aguiContent;
}

/**
 * The legacy binary content part, which left `@ag-ui/core` in 1.0 (the
 * 0.0.47 client middleware converts it on modern pipelines). Old producers
 * still send it straight to servers, so this boundary keeps reading it —
 * typed locally, because the protocol no longer knows the shape.
 */
interface LegacyBinaryInputContent {
  type: "binary";
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
}

/** Convert typed and legacy media while preserving modality and source. */
function convertAguiMultimodalToLangchain(
  content: Array<InputContent | LegacyBinaryInputContent>,
): LangchainContentBlock[] {
  const langchainContent: LangchainContentBlock[] = [];

  for (const item of content) {
    // Same reason as the inbound converter: this array is client JSON, nothing
    // validates it at this boundary in TypeScript, and `item.type` on a `null`
    // entry throws from inside the loop that converts the whole message list.
    if (!item || typeof item !== "object") {
      console.warn(
        "[convertAguiMultimodalToLangchain] Dropping content item: not an object",
      );
      continue;
    }

    if (item.type === "text") {
      // Same read as the inbound converter's text branch. Python reaches this
      // point with a pydantic-validated `TextInputContent`, so its `text` is a
      // `str` by construction; nothing validates the equivalent here, and a
      // non-string forwarded into a provider content block is a 400 from the
      // provider rather than a dropped word.
      const text = item.text === undefined ? "" : item.text;
      if (typeof text !== "string") {
        console.warn(
          `[convertAguiMultimodalToLangchain] Dropping text content: text is ${text === null ? "null" : typeof text}, not a string`,
        );
        continue;
      }
      langchainContent.push({
        type: "text",
        text,
      });
    } else if (MEDIA_CONTENT_TYPES.has(item.type)) {
      // ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent
      const mediaItem = item as
        | ImageInputContent
        | AudioInputContent
        | VideoInputContent
        | DocumentInputContent;
      const inline = inlineMediaData(mediaItem.source);
      const remoteUrl =
        mediaItem.source?.type === "url"
          ? firstNonEmptyString(mediaItem.source.value)
          : undefined;
      const standard = standardBlockTypeFor(
        item.type,
        inline ? inline.mimeType : mediaItem.source?.mimeType,
        !!inline,
      );
      if (standard && (inline || remoteUrl)) {
        langchainContent.push(
          standardMediaBlock(
            standard.type,
            inline ? inline.value : remoteUrl!,
            standard.mimeType,
            filenameFromMetadata(mediaItem.metadata),
            inline ? "base64" : "url",
          ),
        );
        continue;
      }

      const url = mediaSourceToUrl(mediaItem.source);
      if (url) {
        langchainContent.push({
          type: "image_url",
          image_url: { url },
        });
      } else {
        console.warn(
          `[convertAguiMultimodalToLangchain] Dropping ${item.type} content: source could not be converted to URL`,
        );
      }
    } else if (item.type === "binary") {
      // Legacy binary content identifies its modality through MIME type.
      const declaredMimeType = firstNonEmptyString(item.mimeType) ?? "";
      // The three payload keys, read through the SAME helper as the MIME type
      // above and for the same reason: a legacy item is off-the-wire client JSON,
      // its `url` / `data` / `id` are declared `string` and nothing enforces it,
      // and each one is emitted VERBATIM below — `image_url: { url: 42 }` on the
      // provider request, or `data:image/png;base64,42` built out of a number.
      // An unusable payload is an ABSENT payload, so a `url` of `42` no longer
      // outranks a usable `data`, and an item whose three keys are all unusable
      // falls into the guard at the bottom of this branch and is dropped with the
      // warning it already emits. Python's `convert_agui_multimodal_to_langchain`
      // reads the same three keys the same way.
      const suppliedUrl = firstNonEmptyString(item.url);
      const suppliedData = firstNonEmptyString(item.data);
      const suppliedId = firstNonEmptyString(item.id);
      // A legacy item's `url` is a source classification point too, and a
      // `data:` URL sitting in it is the same defect the typed path above has:
      // bytes, labelled as a reference, sent to the provider as `image_url`.
      // Resolved here so the ONE data-URL rule covers both entry points.
      //
      // The url is inspected FIRST and its mediatype wins, because `url` already
      // outranks `data` in the reference form built below — this branch must not
      // promote one payload while the fallback would have sent the other.
      const inlineUrl = parseBase64DataUrl(suppliedUrl);
      const inlineValue = inlineUrl
        ? inlineUrl.data
        : suppliedUrl
          ? undefined
          : suppliedData;
      const mimeType = inlineUrl
        ? (inlineUrl.mimeType ?? declaredMimeType)
        : declaredMimeType;
      // Modality is read off a case-folded copy: MIME types are case-insensitive
      // (RFC 2045 §5.1), so `AUDIO/WAV` names the same modality as `audio/wav`
      // and must not be routed as a document. The ORIGINAL string is what gets
      // emitted for documents, where it is carried inside a data URL rather than
      // matched against an enum.
      const modality = mimeType.split(";")[0].trim().toLowerCase();

      if (
        (inlineValue || suppliedUrl) &&
        mimeType &&
        !modality.startsWith("image/")
      ) {
        const mediaType = modality.startsWith("audio/")
          ? "audio"
          : modality.startsWith("video/")
            ? "video"
            : "document";
        const standard = standardBlockTypeFor(
          mediaType,
          mimeType,
          !!inlineValue,
        );
        if (standard) {
          langchainContent.push(
            standardMediaBlock(
              standard.type,
              inlineValue || suppliedUrl!,
              standard.mimeType,
              firstNonEmptyString(item.filename),
              inlineValue ? "base64" : "url",
            ),
          );
          continue;
        }
      }

      let url: string;

      // Prioritize url, then data, then id
      if (suppliedUrl) {
        url = suppliedUrl;
      } else if (suppliedData) {
        // Construct data URL from base64 data. The NORMALIZED `mimeType`, not
        // `item.mimeType`: the raw one is optional on a legacy binary item, and
        // interpolating an absent one writes the literal text `undefined` into
        // the data URL. Same collapse as {@link mediaSourceToUrl}, which is the
        // typed path's version of this line.
        url = `data:${mimeType};base64,${suppliedData}`;
      } else if (suppliedId) {
        // Use id as a reference
        url = suppliedId;
      } else {
        console.warn(
          "[convertAguiMultimodalToLangchain] Dropping BinaryInputContent: no url, data, or id provided",
        );
        continue;
      }

      langchainContent.push({
        type: "image_url",
        image_url: { url },
      });
    } else {
      // Rule 2 of the malformed-input contract, and the exact mirror of the
      // `else` Python's `convert_agui_multimodal_to_langchain` already carries.
      // An item matching NO branch used to fall out of the loop leaving nothing
      // behind — no block and no log — while every other drop in this same loop
      // says so. A new content type added to the AG-UI union lands here.
      console.warn(
        `[convertAguiMultimodalToLangchain] Dropping unsupported content item of type ${JSON.stringify((item as { type?: unknown }).type)}`,
      );
    }
  }

  return langchainContent;
}

// A reasoning content block as it appears on a LangChain assistant message
// (OpenAI Responses `responses/v1` shape). It is not part of the LangGraph SDK's
// typed content union, so it is declared here for narrowing.
interface ReasoningSummaryEntry {
  type?: string;
  text?: string;
}

interface ReasoningContentBlock {
  type: "reasoning";
  id?: string;
  summary?: ReasoningSummaryEntry[];
  encrypted_content?: string;
  // Flat-text shapes emitted by some non-OpenAI providers.
  reasoning?: string;
  text?: string;
}

function isReasoningBlock(block: unknown): block is ReasoningContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "reasoning"
  );
}

// Extract the human-readable reasoning text from a reasoning content block.
function reasoningBlockSummaryText(block: ReasoningContentBlock): string {
  if (Array.isArray(block.summary)) {
    const parts = block.summary
      .map((entry) => entry?.text)
      .filter((text): text is string => Boolean(text));
    // Join multi-part summaries with a newline so the parts stay legible
    // instead of being mashed together ("A\nB", not "AB").
    if (parts.length) return parts.join("\n");
  }
  return block.reasoning ?? block.text ?? "";
}

// Turn a LangChain reasoning content block into an AG-UI ReasoningMessage,
// preserving the block id (the provider's `rs_…` handle — under store=true it is
// the only round-trip key) and any encrypted content (needed for store=false).
// Returns null only for a wholly empty block (nothing to render or round-trip).
function reasoningBlockToAguiMessage(
  block: ReasoningContentBlock,
  assistantId: string,
  index = 0,
): ReasoningMessage | null {
  const text = reasoningBlockSummaryText(block);
  const encrypted = block.encrypted_content;
  if (!block.id && !text && !encrypted) return null;
  const message: ReasoningMessage = {
    // Include the block index in the fallback id so multiple id-less reasoning
    // blocks on one message don't collide on the same id.
    id: String(block.id ?? `${assistantId}-reasoning-${index}`),
    role: "reasoning",
    content: text,
  };
  if (encrypted) message.encryptedValue = encrypted;
  return message;
}

// Rebuild the LangChain reasoning content block from an AG-UI ReasoningMessage
// (inverse of reasoningBlockToAguiMessage).
function aguiReasoningMessageToBlock(
  message: ReasoningMessage,
): ReasoningContentBlock {
  const block: ReasoningContentBlock = {
    type: "reasoning",
    id: message.id,
    summary: message.content
      ? [{ type: "summary_text", text: message.content }]
      : [],
  };
  if (message.encryptedValue) block.encrypted_content = message.encryptedValue;
  return block;
}

export function langchainMessagesToAgui(
  messages: LangGraphMessage[],
): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    switch (message.type) {
      case "human": {
        // Handle multimodal content
        let userContent: string | InputContent[];
        if (Array.isArray(message.content)) {
          userContent = convertLangchainMultimodalToAgui(
            message.content as any,
          );
        } else {
          userContent = stringifyIfNeeded(
            resolveMessageContent(message.content),
          );
        }

        out.push({
          id: message.id!,
          role: "user",
          content: userContent,
        });
        break;
      }
      case "ai": {
        // "generic" messages are treated the same as "ai" — LangGraph
        // emits them for non-chat models that don't set a specific type.
        // Surface reasoning content blocks as standalone ReasoningMessages
        // placed BEFORE the assistant message (matching streaming order), so a
        // client with no persistent checkpoint can round-trip them.
        if (Array.isArray(message.content)) {
          message.content.forEach((block, index) => {
            if (isReasoningBlock(block)) {
              const reasoningMsg = reasoningBlockToAguiMessage(
                block,
                message.id!,
                index,
              );
              if (reasoningMsg) out.push(reasoningMsg);
            }
          });
        }
        const aiContent = resolveMessageContent(message.content);
        out.push({
          id: message.id!,
          role: "assistant",
          content: aiContent ? stringifyIfNeeded(aiContent) : "",
          toolCalls: message.tool_calls?.map((tc) => ({
            id: tc.id!,
            type: "function",
            function: {
              name: tc.name,
              // Default missing args to "{}" (parity with the Python side);
              // JSON.stringify(undefined) would emit an invalid `undefined`.
              arguments: JSON.stringify(tc.args ?? {}),
            },
          })),
        });
        break;
      }
      case "system":
        out.push({
          id: message.id!,
          role: "system",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
        });
        break;
      case "tool":
        out.push({
          id: message.id!,
          role: "tool",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
          toolCallId: message.tool_call_id,
          // A LangChain tool result signals failure only through `status`, with no
          // error text. Restore AG-UI's `error` so the failure survives the round
          // trip; the value is a fixed sentinel (#2305) because the original text is
          // not recoverable from the flag alone.
          ...(message.status === "error" ? { error: "error" } : {}),
        });
        break;
      default:
        if ((message as any).type === "generic") {
          // Re-enter the "ai" branch for generic messages
          const aiMsg = message as any;
          if (Array.isArray(aiMsg.content)) {
            aiMsg.content.forEach((block: any, index: number) => {
              if (isReasoningBlock(block)) {
                const reasoningMsg = reasoningBlockToAguiMessage(
                  block,
                  aiMsg.id,
                  index,
                );
                if (reasoningMsg) out.push(reasoningMsg);
              }
            });
          }
          const aiContent = resolveMessageContent(aiMsg.content);
          out.push({
            id: aiMsg.id,
            role: "assistant",
            content: aiContent ? stringifyIfNeeded(aiContent) : "",
            toolCalls: aiMsg.tool_calls?.map((tc: any) => ({
              id: tc.id!,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args ?? {}),
              },
            })),
          });
          break;
        }
        throw new Error(
          "message type returned from LangGraph is not supported.",
        );
    }
  }
  return out;
}

export function aguiMessagesToLangChain(
  messages: Message[],
): LangGraphMessage[] {
  const out: LangGraphMessage[] = [];
  // Reasoning is display-only at the AG-UI layer but lives as a content block ON
  // the assistant AIMessage at the LangChain layer. To round-trip reasoning
  // without loss (so a stateless client can hand the model back its own
  // chain-of-thought), buffer reasoning messages and re-attach them as content
  // blocks on the assistant that follows (matching streaming order). Developer
  // messages stay dropped — they are configured on the agent itself.
  //
  // Reasoning that is NOT immediately followed by an assistant message (trailing,
  // or followed by a user/tool/system message) is intentionally discarded: there
  // is no assistant to attach it to, and re-materializing it as a standalone
  // message causes exponential message duplication and tool-call loops under the
  // add_messages reducer. The snapshot side (langchainMessagesToAgui) only ever
  // emits reasoning immediately before its assistant, so this drop never affects
  // a real round-trip — only hand-crafted / partial inputs.
  let pendingReasoning: ReasoningContentBlock[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "reasoning":
        pendingReasoning.push(aguiReasoningMessageToBlock(message));
        continue;
      case "developer":
        continue;
      case "user": {
        pendingReasoning = [];
        // Handle multimodal content
        let content: UserMessage["content"];
        if (typeof message.content === "string") {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          content = convertAguiMultimodalToLangchain(message.content) as any;
        } else {
          content = String(message.content);
        }

        out.push({
          id: message.id,
          role: message.role,
          content,
          type: "human",
        } as LangGraphMessage);
        break;
      }
      case "assistant": {
        // Fold any buffered reasoning blocks onto this assistant message.
        let content:
          | string
          | Array<ReasoningContentBlock | { type: "text"; text: string }>;
        if (pendingReasoning.length) {
          const blocks: Array<
            ReasoningContentBlock | { type: "text"; text: string }
          > = [...pendingReasoning];
          if (message.content)
            blocks.push({ type: "text", text: message.content });
          content = blocks;
          pendingReasoning = [];
        } else {
          content = message.content ?? "";
        }
        out.push({
          id: message.id,
          type: "ai",
          role: message.role,
          content,
          tool_calls: (message.toolCalls ?? [])
            // Same reason the `arguments` read below is guarded: a tool call
            // missing its `function` is client JSON, not a shape the type can
            // rule out, and `tc.function.name` on one throws from inside the
            // loop that converts the whole message list. Python never reaches
            // this because Pydantic rejects the payload at parse time; here the
            // one unusable call is dropped (it has no name, so there is nothing
            // to invoke) and the rest of the conversion survives.
            .filter((tc: ToolCall) => {
              if (tc?.function) return true;
              console.warn(
                "[aguiMessagesToLangChain] Dropping tool call: no function name or arguments",
              );
              return false;
            })
            .map((tc: ToolCall) => ({
              id: tc.id,
              name: tc.function.name,
              // Guard empty/absent arguments (parity with the Python side):
              // JSON.parse("") throws and would abort the whole conversion.
              args: tc.function.arguments
                ? JSON.parse(tc.function.arguments)
                : {},
              type: "tool_call",
            })),
        } as LangGraphMessage);
        break;
      }
      case "system":
        pendingReasoning = [];
        out.push({
          id: message.id,
          role: message.role,
          content: message.content,
          type: "system",
        } as LangGraphMessage);
        break;
      case "tool": {
        pendingReasoning = [];
        // A tool result is a string or a list of content parts. A LangChain
        // tool message takes a string or LangChain content blocks, never the
        // AG-UI parts themselves: a text-only result is its text, and one
        // carrying media goes through the same conversion a user message gets.
        // Which providers accept media in a tool message is then LangChain's
        // concern, as it already is for user content.
        const toolContent =
          typeof message.content === "string"
            ? message.content
            : contentHasMedia(message.content)
              ? (convertAguiMultimodalToLangchain(message.content) as any)
              : contentToText(message.content);
        out.push({
          content: toolContent,
          role: message.role,
          type: message.role,
          tool_call_id: message.toolCallId,
          id: message.id,
          // Carry the AG-UI failure signal onto LangChain's tool-result status, so a
          // client-reported tool failure is not delivered to the model as a success.
          status: message.error ? "error" : "success",
        } as LangGraphMessage);
        break;
      }
      default:
        console.error(
          `Message role ${(message as { role: string }).role} is not implemented`,
        );
        throw new Error("message role is not supported.");
    }
  }
  return out;
}

function stringifyIfNeeded(item: any) {
  if (typeof item === "string") return item;
  return JSON.stringify(item);
}

export function resolveReasoningContent(
  eventData: any,
): LangGraphReasoning | null {
  const content = eventData.chunk?.content;

  if (content && Array.isArray(content) && content.length && content[0]) {
    const block = content[0];

    // Old langchain-anthropic format: { type: "thinking", thinking: "..." }
    if (block.type === "thinking" && block.thinking) {
      const result: LangGraphReasoning = {
        text: block.thinking,
        type: "text",
        index: block.index ?? 0,
      };
      // Extract signature if present (Anthropic extended thinking signature)
      if (block.signature) {
        result.signature = block.signature;
      }
      return result;
    }

    // New LangChain standardized format: { type: "reasoning", reasoning: "..." }
    if (block.type === "reasoning" && block.reasoning) {
      return {
        text: block.reasoning,
        type: "text",
        index: block.index ?? 0,
      };
    }

    // OpenAI Responses API v1 format: { type: "reasoning", summary: [{ text: "..." }] }
    //
    // The reasoning item's canonical id (OpenAI `rs_…`) only travels on
    // text-less chunks: the `response.output_item.added` chunk ({ id,
    // summary: [] }) and — depending on the langchain-openai version — the
    // `…summary_part.added` chunk ({ id, summary: [{ text: "" }] }). The
    // `…summary_text.delta` chunks carry text but no id. Surface the id
    // carriers (instead of dropping them for having no text) so the streamed
    // reasoning message can adopt the canonical id — the id the snapshot
    // converter emits for the same block; handleReasoningEvent stashes the id
    // without opening a message, so summary-less (store=true) items still
    // render nothing. Only the first summary part takes the id: later parts
    // belong to the same item, and reusing its id would mint two messages
    // with one id.
    if (block.type === "reasoning" && Array.isArray(block.summary)) {
      if (block.summary.length === 0 && block.id) {
        return {
          type: "text",
          text: "",
          index: block.index ?? 0,
          id: String(block.id),
        };
      }
      const part = block.summary[0];
      if (part && typeof part === "object" && (part.text || block.id)) {
        const result: LangGraphReasoning = {
          type: "text",
          text: part.text ?? "",
          index: part.index ?? 0,
        };
        if (block.id && (part.index ?? 0) === 0) {
          result.id = String(block.id);
        }
        return result;
      }
    }

    // Bedrock Converse API format: { type: "reasoning_content", reasoning_content: { type: "text", text: "..." } }
    if (block.type === "reasoning_content" && block.reasoning_content?.text) {
      return {
        type: "text",
        text: block.reasoning_content.text,
        index: block.reasoning_content.index ?? 0,
      };
    }
  }

  // OpenAI legacy format via additional_kwargs
  if (eventData.chunk?.additional_kwargs?.reasoning?.summary?.[0]) {
    const data = eventData.chunk.additional_kwargs.reasoning.summary[0];
    if (!data || !data.text) return null;
    return {
      type: "text",
      text: data.text,
      index: data.index ?? 0,
    };
  }

  // DeepSeek-style format: additional_kwargs.reasoning_content (plain string)
  const reasoningContent =
    eventData.chunk?.additional_kwargs?.reasoning_content;
  if (reasoningContent && typeof reasoningContent === "string") {
    return {
      type: "text",
      text: reasoningContent,
      index: 0,
    };
  }

  return null;
}

/**
 * Resolves encrypted reasoning content from Anthropic responses.
 * This handles:
 * - `signature` fields on thinking blocks (cryptographic verification)
 * - `redacted_thinking` blocks with encrypted `data` (redacted chain-of-thought)
 */
export function resolveEncryptedReasoningContent(
  eventData: any,
): string | null {
  const content = eventData.chunk?.content;

  if (!content || !Array.isArray(content) || !content.length || !content[0]) {
    return null;
  }

  // Anthropic redacted_thinking block: { type: "redacted_thinking", data: "..." }
  if (content[0].type === "redacted_thinking" && content[0].data) {
    return content[0].data;
  }

  return null;
}

export function resolveMessageContent(
  content?: LangGraphMessage["content"],
): string | null {
  if (!content) return null;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content) && content.length) {
    // `c?.type`, not `c.type`: this array is whatever the graph put on the
    // message, and a `null` entry in it would throw out of `find` — aborting
    // the conversion of the whole message list rather than skipping the entry
    // and finding the text block that follows it.
    const contentText = content.find((c) => c?.type === "text")?.text;
    return contentText ?? null;
  }

  return null;
}
