import {configureHTML} from "lezer-html"
import {cssSyntax} from "../../lang-css"
import {javascriptSyntax} from "../../lang-javascript"
import {LezerSyntax, delimitedIndent, continuedIndent, indentNodeProp, foldNodeProp, openNodeProp, closeNodeProp} from "../../syntax"
import {NodeType, Subtree} from "lezer-tree"
import {styleTags} from "../../highlight"

/// A syntax provider based on the [Lezer HTML
/// parser](https://github.com/lezer-parser/html), wired up with the
/// JavaScript and CSS parsers to parse the content of `<script>` and
/// `<style>` tags.
export const htmlSyntax = new LezerSyntax(configureHTML([
  {tag: "script",
   attrs(attrs) {
     return !attrs.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^module$|^$/i.test(attrs.type)
   },
   parser: javascriptSyntax.parser},
  {tag: "style",
   attrs(attrs) {
     return (!attrs.lang || attrs.lang == "css") && (!attrs.type || /^(text\/)?(x-)?(stylesheet|css)$/i.test(attrs.type))
   },
   parser: cssSyntax.parser}
]).withProps(
  indentNodeProp.add(type => {
    if (type.name == "Element") return delimitedIndent({closing: "</", align: false})
    if (type.name == "OpenTag" || type.name == "CloseTag" || type.name == "SelfClosingTag") return continuedIndent()
    return undefined
  }),
  foldNodeProp.add(NodeType.match({
    Element(subtree: Subtree) {
      let first = subtree.firstChild, last = subtree.lastChild!
      if (!first || first.name != "OpenTag") return null
      return {from: first.end, to: last.name == "CloseTag" ? last.start : subtree.end}
    }
  })),
  openNodeProp.add(NodeType.match({
    "StartTag StartCloseTag": ["EndTag", "SelfCloseEndTag"],
    "OpenTag": ["CloseTag"]
  })),
  closeNodeProp.add(NodeType.match({
    "EndTag SelfCloseEndTag": ["StartTag", "StartCloseTag"],
    "CloseTag": ["OpenTag"]
  })),
  styleTags({
    AttributeValue: "string",
    "Text RawText": "content",
    "StartTag StartCloseTag SelfCloserEndTag EndTag SelfCloseEndTag": "angleBracket",
    TagName: "typeName",
    MismatchedTagName: "typeName invalid",
    AttributeName: "propertyName",
    UnquotedAttributeValue: "string",
    Is: "operator definition",
    "EntityReference CharacterReference": "character",
    Comment: "blockComment",
    ProcessingInst: "operator meta",
    DoctypeDecl: "labelName meta"
  })
))

/// Returns an extension that installs the HTML syntax provider.
export function html() { return htmlSyntax.extension }