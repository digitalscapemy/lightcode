import type { LayoutNode, Orientation, PaneNode } from '../../shared/types'

export function paneIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(paneIds)
}

export function paneNodes(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(paneNodes)
}

export function firstPaneId(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : firstPaneId(node.children[0])
}

/** Equalize every split so all siblings share space evenly. */
export function balance(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return node
  return {
    ...node,
    children: node.children.map(balance),
    sizes: node.children.map(() => 1 / node.children.length)
  }
}

/**
 * Split `targetId` in the given orientation, adding `newPaneId` after it.
 * If the target's parent split already has that orientation, the new pane is
 * inserted as a sibling (a row of 2 becomes a row of 3, not nested rows).
 * The whole tree is rebalanced afterwards.
 */
export function splitPane(
  root: LayoutNode,
  targetId: string,
  orientation: Orientation,
  newPaneId: string,
  before = false
): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (node.id !== targetId) return node
      const pair: LayoutNode[] = before
        ? [{ type: 'pane', id: newPaneId }, node]
        : [node, { type: 'pane', id: newPaneId }]
      return { type: 'split', orientation, children: pair, sizes: [0.5, 0.5] }
    }
    if (node.orientation === orientation) {
      const idx = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
      if (idx !== -1) {
        const children = [...node.children]
        children.splice(before ? idx : idx + 1, 0, { type: 'pane', id: newPaneId })
        return { ...node, children, sizes: children.map(() => 1 / children.length) }
      }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return balance(walk(root))
}

/**
 * Remove a pane; single-child splits collapse into the child.
 * Returns null when the last pane was removed.
 */
export function removePane(root: LayoutNode, targetId: string): LayoutNode | null {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === targetId ? null : node
    const children = node.children.map(walk).filter((c): c is LayoutNode => c !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return { ...node, children, sizes: children.map(() => 1 / children.length) }
  }
  const result = walk(root)
  return result ? balance(result) : null
}
