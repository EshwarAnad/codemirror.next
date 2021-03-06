import {Tree, SyntaxNode, ChangedRange, TreeFragment, NodeProp, NodeType,
        Input, PartialParse, ParseContext} from "lezer-tree"
// NOTE: This package should only use _types_ from "lezer", to avoid
// pulling in that dependency when no actual Lezer-based parser is used.
import {Parser, ParserConfig} from "lezer"
import {Text, TextIterator} from "@codemirror/next/text"
import {EditorState, StateField, Transaction, Extension, StateEffect, Facet, ChangeDesc} from "@codemirror/next/state"
import {ViewPlugin, ViewUpdate, EditorView} from "@codemirror/next/view"
import {treeHighlighter} from "@codemirror/next/highlight"

/// Node prop stored on a grammar's top node to indicate the facet used
/// to store language data related to that language.
export const languageDataProp = new NodeProp<Facet<{[name: string]: any}>>()

/// Helper function to define a facet (to be added to the top syntax
/// node(s) for a language via
/// [`languageDataProp`](#language.languageDataProp)), that will be
/// used to associate language data with the language. You
/// probably only need this when subclassing
/// [`Language`](#language.Language).
export function defineLanguageFacet(baseData?: {[name: string]: any}) {
  return Facet.define<{[name: string]: any}>({
    combine: baseData ? values => values.concat(baseData!) : undefined
  })
}

/// A language object manages parsing and per-language
/// [metadata](#state.EditorState.languageDataAt). Parse data is
/// managed as a [Lezer](https://lezer.codemirror.net) tree. You'll
/// want to subclass this class for custom parsers, or use the
/// [`LezerLanguage`](#language.LezerLanguage) or
/// [`StreamLanguage`](#stream-parser.StreamLanguage) abstractions for
/// [Lezer](https://lezer.codemirror.net/) or stream parsers.
export class Language {
  /// The extension value to install this provider.
  readonly extension: Extension

  /// The parser (with [language data
  /// facet](#language.defineLanguageFacet) attached). Can be useful
  /// when using this as a [nested
  /// parser](https://lezer.codemirror.net/docs/ref#lezer.NestedParserSpec).
  parser: {startParse: (input: Input, startPos: number, context: ParseContext) => PartialParse}

  /// Construct a language object. You usually don't need to invoke
  /// this directly. But when you do, make sure you use
  /// `defineLanguageFacet` to create the first argument.
  constructor(
    /// The [language data](#state.EditorState.languageDataAt) data
    /// facet used for this language.
    readonly data: Facet<{[name: string]: any}>,
    parser: {startParse(input: Input, pos: number, context: EditorParseContext): PartialParse},
    extraExtensions: Extension[] = []
  ) {
    // Kludge to define EditorState.tree as a debugging helper,
    // without the EditorState package actually knowing about
    // languages and lezer trees.
    if (!EditorState.prototype.hasOwnProperty("tree"))
      Object.defineProperty(EditorState.prototype, "tree", {get() { return syntaxTree(this) }})

    this.parser = parser as {startParse: (input: Input, startPos: number, context: ParseContext) => PartialParse}
    this.extension = [
      language.of(this),
      EditorState.languageData.of((state, pos) => state.facet(languageDataFacetAt(state, pos)!))
    ].concat(extraExtensions)
  }

  /// Query whether this language is active at the given position.
  isActiveAt(state: EditorState, pos: number) {
    return languageDataFacetAt(state, pos) == this.data
  }

  /// Find the document regions that were parsed using this language.
  /// The returned regions will _include_ any nested languages rooted
  /// in this language, if applicable.
  findRegions(state: EditorState) {
    let lang = state.facet(language)
    if (lang?.data == this.data) return [{from: 0, to: state.doc.length}]
    if (!lang || !lang.allowsNesting) return []
    let result: {from: number, to: number}[] = []
    syntaxTree(state).iterate({
      enter: (type, from, to) => {
        if (type.isTop && type.prop(languageDataProp) == this.data) {
          result.push({from, to})
          return false
        }
        return undefined
      }
    })
    return result
  }

  /// Indicates whether this language allows nested languages. The
  /// default implementation returns true.
  get allowsNesting() { return true }

  /// Use this language to parse the given string into a tree.
  parseString(code: string) {
    let doc = Text.of(code.split("\n"))
    let parse = this.parser.startParse(new DocInput(doc), 0,
                                       new EditorParseContext(this.parser, EditorState.create({doc}), [],
                                                              Tree.empty, {from: 0, to: code.length}, []))
    let tree
    while (!(tree = parse.advance())) {}
    return tree
  }

  /// @internal
  static state: StateField<LanguageState> = StateField.define({
    create(state) {
      let parseState = new EditorParseContext(state.facet(language)!.parser, state, [],
                                              Tree.empty, {from: 0, to: state.doc.length}, [])
      if (!parseState.work(Work.Apply)) parseState.takeTree()
      return new LanguageState(parseState)
    },
    update(value, tr) {
      for (let e of tr.effects) if (e.is(Language.setState)) return e.value
      return value.apply(tr)
    }
  })

  /// @internal
  static setState = StateEffect.define<LanguageState>()
}

function languageDataFacetAt(state: EditorState, pos: number) {
  let topLang = state.facet(language)
  if (!topLang) return null
  if (!topLang.allowsNesting) return topLang.data
  let tree = syntaxTree(state)
  let target: SyntaxNode | null = tree.resolve(pos, -1)
  while (target) {
    let facet = target.type.prop(languageDataProp)
    if (facet) return facet
    target = target.parent
  }
  return topLang.data
}

/// A subclass of `Language` for use with
/// [Lezer](https://lezer.codemirror.net/docs/ref#lezer.Parser)
/// parsers.
export class LezerLanguage extends Language {
  private constructor(data: Facet<{[name: string]: any}>,
                      readonly parser: Parser) {
    super(data, parser)
  }

  /// Define a language from a parser.
  static define(spec: {
    /// The parser to use. Should already have added editor-relevant
    /// node props (and optionally things like dialect and top rule)
    /// configured.
    parser: Parser,
    /// [Language data](#state.EditorState.languageDataAt)
    /// to register for this language.
    languageData?: {[name: string]: any}
  }) {
    let data = defineLanguageFacet(spec.languageData)
    return new LezerLanguage(data, spec.parser.configure({
      props: [languageDataProp.add(type => type.isTop ? data : undefined)]
    }))
  }

  /// Create a new instance of this language with a reconfigured
  /// version of its parser.
  configure(options: ParserConfig): LezerLanguage {
    return new LezerLanguage(this.data, this.parser.configure(options))
  }

  get allowsNesting() { return this.parser.hasNested }
}

/// Get the syntax tree for a state, which is the current (possibly
/// incomplete) parse tree of the [language](#language.Language) with
/// the highest precedence, or the empty tree if there is no language
/// available.
export function syntaxTree(state: EditorState): Tree {
  let field = state.field(Language.state, false)
  return field ? field.tree : Tree.empty
}

/// Try to get a parse tree that spans at least up to `upto`. The
/// method will do at most `timeout` milliseconds of work to parse
/// up to that point if the tree isn't already available.
export function ensureSyntaxTree(state: EditorState, upto: number, timeout = 100): Tree | null {
  let parse = state.field(Language.state, false)?.context
  return !parse ? null : parse.tree.length >= upto || parse.work(timeout, upto) ? parse.tree : null
}

// Lezer-style Input object for a Text document.
class DocInput implements Input {
  cursor: TextIterator
  cursorPos = 0
  string = ""
  prevString = ""

  constructor(readonly doc: Text, readonly length: number = doc.length) {
    this.cursor = doc.iter()
  }

  private syncTo(pos: number) {
    if (pos < this.cursorPos) { // Reset the cursor if we have to go back
      this.cursor = this.doc.iter()
      this.cursorPos = 0
    }
    this.prevString = pos == this.cursorPos ? this.string : ""
    this.string = this.cursor.next(pos - this.cursorPos).value
    this.cursorPos = pos + this.string.length
    return this.cursorPos - this.string.length
  }

  get(pos: number) {
    if (pos >= this.length) return -1
    let stringStart = this.cursorPos - this.string.length
    if (pos < stringStart || pos >= this.cursorPos) {
      if (pos < stringStart && pos >= stringStart - this.prevString.length)
        return this.prevString.charCodeAt(pos - (stringStart - this.prevString.length))
      stringStart = this.syncTo(pos)
    }
    return this.string.charCodeAt(pos - stringStart)
  }

  lineAfter(pos: number) {
    if (pos >= this.length || pos < 0) return ""
    let stringStart = this.cursorPos - this.string.length
    if (pos < stringStart || pos >= this.cursorPos) stringStart = this.syncTo(pos)
    let off = pos - stringStart, result = ""
    while (!this.cursor.lineBreak) {
      result += off ? this.string.slice(off) : this.string
      if (this.cursorPos >= this.length) {
        if (this.cursorPos > this.length) result = result.slice(0, result.length - (this.cursorPos - this.length))
        break
      }
      this.syncTo(this.cursorPos)
      off = 0
    }
    return result
  }

  read(from: number, to: number) {
    let stringStart = this.cursorPos - this.string.length
    if (from < stringStart || to >= this.cursorPos)
      return this.doc.sliceString(from, to)
    else
      return this.string.slice(from - stringStart, to - stringStart)
  }

  clip(at: number) {
    return new DocInput(this.doc, at)
  }
}

const enum Work {
  // Milliseconds of work time to perform immediately for a state doc change
  Apply = 25,
  // Minimum amount of work time to perform in an idle callback
  MinSlice = 25,
  // Amount of work time to perform in pseudo-thread when idle callbacks aren't supported
  Slice = 100,
  // Maximum pause (timeout) for the pseudo-thread
  Pause = 500,
  // Parse time budgets are assigned per chunk—the parser can run for
  // ChunkBudget milliseconds at most during ChunkTime milliseconds.
  // After that, no further background parsing is scheduled until the
  // next chunk in which the editor is active.
  ChunkBudget = 3000,
  ChunkTime = 30000,
  // For every change the editor receives while focused, it gets a
  // small bonus to its parsing budget (as a way to allow active
  // editors to continue doing work).
  ChangeBonus = 50
}

/// A parse context provided to parsers working on the editor content.
export class EditorParseContext implements ParseContext {
  private parse: PartialParse | null = null
  /// @internal
  tempSkipped: {from: number, to: number}[] = []

  /// @internal
  constructor(
    private parser: {startParse(input: Input, pos: number, context: ParseContext): PartialParse},
    /// The current editor state.
    readonly state: EditorState,
    /// Tree fragments that can be reused by new parses.
    public fragments: readonly TreeFragment[] = [],
    /// @internal
    public tree: Tree,
    /// The current editor viewport, or some approximation thereof.
    /// Intended to be used for opportunistically avoiding work (in
    /// which case
    /// [`skipUntilInView`](#language.EditorParseContext.skipUntilInView)
    /// should be called to make sure the parser is restarted when the
    /// skipped region becomes visible).
    public viewport: {from: number, to: number},
    /// @internal
    public skipped: {from: number, to: number}[]
  ) {}

  /// @internal
  work(time: number, upto?: number) {
    if (this.tree != Tree.empty && (upto == null ? this.tree.length == this.state.doc.length : this.tree.length >= upto))
      return true
    if (!this.parse)
      this.parse = this.parser.startParse(new DocInput(this.state.doc), 0, this)
    let endTime = Date.now() + time
    for (;;) {
      let done = this.parse.advance()
      if (done) {
        this.fragments = this.withoutTempSkipped(TreeFragment.addTree(done))
        this.parse = null
        this.tree = done
        return true
      } else if (upto != null && this.parse.pos >= upto) {
        this.takeTree()
        return true
      }
      if (Date.now() > endTime) return false
    }
  }
  
  /// @internal
  takeTree() {
    if (this.parse && this.parse.pos > this.tree.length) {
      this.tree = this.parse.forceFinish()
      this.fragments = this.withoutTempSkipped(TreeFragment.addTree(this.tree, this.fragments, true))
    }
  }

  private withoutTempSkipped(fragments: readonly TreeFragment[]) {
    for (let r; r = this.tempSkipped.pop();)
      fragments = cutFragments(fragments, r.from, r.to)
    return fragments
  }

  /// @internal
  changes(changes: ChangeDesc, newState: EditorState) {
    let {fragments, tree, viewport, skipped} = this
    this.takeTree()
    if (!changes.empty) {
      let ranges: ChangedRange[] = []
      changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({fromA, toA, fromB, toB}))
      fragments = TreeFragment.applyChanges(fragments, ranges)
      tree = Tree.empty
      viewport = {from: changes.mapPos(viewport.from, -1), to: changes.mapPos(viewport.to, 1)}
      if (this.skipped.length) {
        skipped = []
        for (let r of this.skipped) {
          let from = changes.mapPos(r.from, 1), to = changes.mapPos(r.to, -1)
          if (from < to) skipped.push({from, to})
        }
      }
    }
    return new EditorParseContext(this.parser, newState, fragments, tree, viewport, skipped)
  }

  /// @internal
  updateViewport(viewport: {from: number, to: number}) {
    this.viewport = viewport
    let startLen = this.skipped.length
    for (let i = 0; i < this.skipped.length; i++) {
      let {from, to} = this.skipped[i]
      if (from < viewport.to && to > viewport.from) {
        this.fragments = cutFragments(this.fragments, from, to)
        this.skipped.splice(i--, 1)
      }
    }
    return this.skipped.length < startLen
  }

  /// @internal
  reset() {
    if (this.parse) {
      this.takeTree()
      this.parse = null
    }
  }

  /// Notify the parse scheduler that the given region was skipped
  /// because it wasn't in view, and the parse should be restarted
  /// when it comes into view.
  skipUntilInView(from: number, to: number) {
    this.skipped.push({from, to})
  }

  /// A parser intended to be used as placeholder when asynchronously
  /// loading a nested parser. It'll skip its input and mark it as
  /// not-really-parsed, so that the next update will parse it again.
  static skippingParser = {
    startParse(input: Input, startPos: number, context: ParseContext): PartialParse {
      return {
        pos: startPos,
        advance() {
          ;(context as EditorParseContext).tempSkipped.push({from: startPos, to: input.length})
          this.pos = input.length
          return new Tree(NodeType.none, [], [], input.length - startPos)
        },
        forceFinish() { return this.advance() as Tree }
      }
    }
  }
}

function cutFragments(fragments: readonly TreeFragment[], from: number, to: number) {
  return TreeFragment.applyChanges(fragments, [{fromA: from, toA: to, fromB: from, toB: to}])
}

class LanguageState {
  // The current tree. Immutable, because directly accessible from
  // the editor state.
  readonly tree: Tree

  constructor(
    // A mutable parse state that is used to preserve work done during
    // the lifetime of a state when moving to the next state.
    readonly context: EditorParseContext
  ) {
    this.tree = context.tree
  }

  apply(tr: Transaction) {
    if (!tr.docChanged) return this
    let newCx = this.context.changes(tr.changes, tr.state)
    // If the previous parse wasn't done, go forward only up to its
    // end position or the end of the viewport, to avoid slowing down
    // state updates with parse work beyond the viewport.
    let upto = this.context.tree.length == tr.startState.doc.length ? undefined
      : Math.max(tr.changes.mapPos(this.context.tree.length), newCx.viewport.to)
    if (!newCx.work(Work.Apply, upto)) newCx.takeTree()
    return new LanguageState(newCx)
  }
}

type Deadline = {timeRemaining(): number, didTimeout: boolean}
type IdleCallback = (deadline?: Deadline) => void

let requestIdle: (callback: IdleCallback, options: {timeout: number}) => number =
  typeof window != "undefined" && (window as any).requestIdleCallback ||
  ((callback: IdleCallback, {timeout}: {timeout: number}) => setTimeout(callback, timeout))
let cancelIdle: (id: number) => void = typeof window != "undefined" && (window as any).cancelIdleCallback || clearTimeout

const parseWorker = ViewPlugin.fromClass(class ParseWorker {
  working: number = -1
  // End of the current time chunk
  chunkEnd = -1
  // Milliseconds of budget left for this chunk
  chunkBudget = -1

  constructor(readonly view: EditorView) {
    this.work = this.work.bind(this)
    this.scheduleWork()
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      if (this.view.hasFocus) this.chunkBudget += Work.ChangeBonus
      this.scheduleWork()
    }
    let cx = this.view.state.field(Language.state).context
    if (update.viewportChanged && cx.updateViewport(update.view.viewport)) {
      cx.reset()
      this.scheduleWork()
    }
  }

  scheduleWork() {
    if (this.working > -1) return
    let {state} = this.view, field = state.field(Language.state)
    if (field.tree.length >= state.doc.length) return
    this.working = requestIdle(this.work, {timeout: Work.Pause})
  }

  work(deadline?: Deadline) {
    this.working = -1

    let now = Date.now()
    if (this.chunkEnd < now && this.view.hasFocus) { // Start a new chunk
      this.chunkEnd = now + Work.ChunkTime
      this.chunkBudget = Work.ChunkBudget
    }
    if (this.chunkBudget <= 0) return // No more budget

    let {state} = this.view, field = state.field(Language.state)
    if (field.tree.length >= state.doc.length) return
    let time = Math.min(this.chunkBudget, deadline ? Math.max(Work.MinSlice, deadline.timeRemaining()) : Work.Slice)
    field.context.work(time)
    this.chunkBudget -= Date.now() - now
    if (field.context.tree.length >= state.doc.length) {
      this.view.dispatch({effects: Language.setState.of(new LanguageState(field.context))})
    } else {
      this.scheduleWork()
    }
  }

  destroy() {
    if (this.working >= 0) cancelIdle(this.working)
  }
}, {
  eventHandlers: {focus() { this.scheduleWork() }}
})

/// The facet used to associate a language with an editor state.
export const language = Facet.define<Language, Language | null>({
  combine(languages) { return languages.length ? languages[0] : null },
  enables: [Language.state, parseWorker, treeHighlighter]
})

/// This class bundles a [language object](#language.Language) with an
/// optional set of supporting extensions. Language packages are
/// encouraged to export a function that optionally takes a
/// configuration object and returns a `LanguageSupport` instance, as
/// the main way for client code to use the package.
export class LanguageSupport {
  /// An extension including both the language and its support
  /// extensions. (Allowing the object to be used as an extension
  /// value itself.)
  extension: Extension

  /// Create a support object.
  constructor(
    /// The language object.
    readonly language: Language,
    /// An optional set of supporting extensions.
    readonly support: Extension = []
  ) {
    this.extension = [language, support]
  }
}

/// Language descriptions are used to store metadata about languages
/// and to dynamically load them. Their main role is finding the
/// appropriate language for a filename or dynamically loading nested
/// parsers.
export class LanguageDescription {
  /// If the language has been loaded, this will hold its value.
  support: LanguageSupport | undefined = undefined

  private loading: Promise<LanguageSupport> | null = null

  private constructor(
    /// The name of this mode.
    readonly name: string,
    /// Alternative names for the mode (lowercased, includes `this.name`).
    readonly alias: readonly string[],
    /// File extensions associated with this language.
    readonly extensions: readonly string[],
    /// Optional filename pattern that should be associated with this
    /// language.
    readonly filename: RegExp | undefined,
    private loadFunc: () => Promise<LanguageSupport>
  ) {}

  /// Start loading the the language. Will return a promise that
  /// resolves to a [`LanguageSupport`](#language.LanguageSupport)
  /// object when the language successfully loads.
  load(): Promise<LanguageSupport> {
    return this.loading || (this.loading = this.loadFunc().then(
      support => this.support = support,
      err => { this.loading = null; throw err }
    ))
  }

  /// Create a language description.
  static of(spec: {
    /// The language's name.
    name: string,
    /// An optional array of alternative names.
    alias?: readonly string[],
    /// An optional array of extensions associated with this language.
    extensions?: readonly string[],
    /// An optional filename pattern associated with this language.
    filename?: RegExp,
    /// A function that will asynchronously load the language.
    load: () => Promise<LanguageSupport>
  }) {
    return new LanguageDescription(spec.name, (spec.alias || []).concat(spec.name).map(s => s.toLowerCase()),
                                   spec.extensions || [], spec.filename, spec.load)
  }

  /// Look for a language in the given array of descriptions that
  /// matches the filename. Will first match
  /// [`filename`](#language.LanguageDescription.filename) patterns,
  /// and then [extensions](#language.LanguageDescription.extensions),
  /// and return the first language that matches.
  static matchFilename(descs: readonly LanguageDescription[], filename: string) {
    for (let d of descs) if (d.filename && d.filename.test(filename)) return d
    let ext = /\.([^.]+)$/.exec(filename)
    if (ext) for (let d of descs) if (d.extensions.indexOf(ext[1]) > -1) return d
    return null
  }

  /// Look for a language whose name or alias matches the the given
  /// name (case-insensitively). If `fuzzy` istrue, and no direct
  /// matchs is found, this'll also search for a language whose name
  /// or alias occurs in the string (for names shorter than three
  /// characters, only when surrounded by non-word characters).
  static matchLanguageName(descs: readonly LanguageDescription[], name: string, fuzzy = true) {
    name = name.toLowerCase()
    for (let d of descs) if (d.alias.some(a => a == name)) return d
    if (fuzzy) for (let d of descs) for (let a of d.alias) {
      let found = name.indexOf(a)
      if (found > -1 && (a.length > 2 || !/\w/.test(name[found - 1]) && !/\w/.test(name[found + a.length])))
        return d
    }
    return null
  }
}
