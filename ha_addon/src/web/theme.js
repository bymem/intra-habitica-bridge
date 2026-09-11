/**
 * Follow Home Assistant's theme.
 *
 * Custom properties do not cross an iframe boundary, so a theme cannot simply
 * be inherited. But Ingress serves this page from Home Assistant's own origin
 * and the iframe carries no sandbox attribute, so the parent document is
 * readable — its computed theme variables can be copied onto ours.
 *
 * Everything here degrades to the built-in palette if that ever stops being
 * true: opened outside Ingress, or a future HA that sandboxes the frame. The
 * page keeps working, it just stops following.
 */

/**
 * Ours to theirs. Several candidates per entry because themes vary in which
 * variables they define; the first one with a value wins.
 */
const VARIABLES = {
  '--bg': ['--primary-background-color', '--lovelace-background'],
  '--panel': ['--card-background-color', '--ha-card-background'],
  '--panel-2': ['--secondary-background-color'],
  '--line': ['--divider-color'],
  '--text': ['--primary-text-color'],
  '--muted': ['--secondary-text-color'],
  '--accent': ['--primary-color'],
};

/**
 * Copy Home Assistant's colours over ours, and keep following if the theme
 * changes while the panel is open. Returns whether it could.
 */
export function followHomeAssistantTheme() {
  const root = parentRoot();
  if (!root) {
    return false;
  }

  apply(root);

  // Home Assistant writes theme variables as inline styles on its <html>, so
  // a change to that attribute is a theme change. Cheaper and more immediate
  // than polling.
  try {
    new MutationObserver(() => apply(root)).observe(root, {
      attributes: true,
      attributeFilter: ['style'],
    });
  } catch {
    // Observation failed; the colours copied above still stand.
  }

  return true;
}

/** The parent document's root, or null when there isn't a readable one. */
function parentRoot() {
  try {
    const root = window.parent?.document?.documentElement;
    // Not framed at all — parent is us.
    if (!root || root === document.documentElement) {
      return null;
    }
    // Reading forces the security error now rather than later if the frame
    // ever becomes cross-origin.
    getComputedStyle(root).getPropertyValue('--primary-text-color');
    return root;
  } catch {
    return null;
  }
}

function apply(root) {
  let theirs;
  try {
    theirs = getComputedStyle(root);
  } catch {
    return;
  }

  for (const [ours, candidates] of Object.entries(VARIABLES)) {
    for (const name of candidates) {
      const value = theirs.getPropertyValue(name).trim();
      if (value) {
        document.documentElement.style.setProperty(ours, value);
        break;
      }
    }
  }
}
