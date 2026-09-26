import ObjectiveC
import UIKit
import WebKit

/// The Mac's page. It differs from a plain WKWebView in one way: no input
/// accessory bar above the on-screen keyboard. WebKit shows its form bar
/// (previous, next, Done) for every focused field, the in-app terminal's
/// included, where it only takes room from the page's own row of Esc, Ctrl,
/// Tab, ^C and arrow keys (web/TerminalView.tsx), which a phone keyboard
/// lacks. The page has no multi-field forms that need previous and next.
/// On iPad the previous/next buttons in the keyboard's shortcut bar go too.
///
/// WKWebView offers no setting for it: the bar is the `inputAccessoryView`
/// of WebKit's content view, the web view's first responder. So that view
/// gets a subclass (made once, at run time) whose public `inputAccessoryView`
/// is nil and whose `inputAssistantItem` has no trailing buttons. Nothing
/// else of WebKit's is touched; if WebKit ever renames or restructures its
/// content view, the bar simply shows again.
final class HivemindWebView: WKWebView {
  override func didMoveToWindow() {
    super.didMoveToWindow()
    Self.hideInputAccessoryBar(in: scrollView)
  }

  private static let suffix = "_HivemindNoInputAccessory"

  static func hideInputAccessoryBar(in scrollView: UIScrollView) {
    guard let content = scrollView.subviews.first(where: { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }) else { return }
    let base: AnyClass = type(of: content)
    let baseName = NSStringFromClass(base)
    guard !baseName.hasSuffix(suffix), let subclass = noAccessorySubclass(of: base, named: baseName + suffix) else { return }
    object_setClass(content, subclass)
    content.reloadInputViews()
  }

  private static func noAccessorySubclass(of base: AnyClass, named name: String) -> AnyClass? {
    if let existing = NSClassFromString(name) { return existing }
    guard let subclass = objc_allocateClassPair(base, name, 0) else { return nil }
    let selector = #selector(getter: UIResponder.inputAccessoryView)
    guard let method = class_getInstanceMethod(UIResponder.self, selector) else {
      objc_disposeClassPair(subclass)
      return nil
    }
    let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    class_addMethod(subclass, selector, imp_implementationWithBlock(none), method_getTypeEncoding(method))
    // On iPad the same previous/next buttons sit at the right of the
    // keyboard's shortcut bar instead; undo, redo and paste on its left stay.
    let assistant = #selector(getter: UIResponder.inputAssistantItem)
    if let original = class_getInstanceMethod(base, assistant) {
      typealias Getter = @convention(c) (AnyObject, Selector) -> UITextInputAssistantItem
      let inherited = unsafeBitCast(method_getImplementation(original), to: Getter.self)
      let withoutNavigation: @convention(block) (AnyObject) -> UITextInputAssistantItem = { view in
        let item = inherited(view, assistant)
        item.trailingBarButtonGroups = []
        return item
      }
      class_addMethod(subclass, assistant, imp_implementationWithBlock(withoutNavigation), method_getTypeEncoding(original))
    }
    objc_registerClassPair(subclass)
    return subclass
  }
}
