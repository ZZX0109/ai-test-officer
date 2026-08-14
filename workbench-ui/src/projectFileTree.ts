export interface FileTreeNode {
  name: string;
  path: string;
  relativePath?: string;
  kind: "directory" | "file";
  children: FileTreeNode[];
  childrenLoaded?: boolean;
}

interface MutableFileTreeNode extends FileTreeNode {
  childIndex: Map<string, MutableFileTreeNode>;
  children: MutableFileTreeNode[];
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const roots: MutableFileTreeNode[] = [];
  const rootIndex = new Map<string, MutableFileTreeNode>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let siblings = roots;
    let siblingIndex = rootIndex;
    let parentPath = "";

    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const currentPath = parentPath ? `${parentPath}/${name}` : name;
      const kind = index === parts.length - 1 ? "file" : "directory";
      const key = `${kind}:${name}`;
      let node = siblingIndex.get(key);
      if (!node) {
        node = { name, path: currentPath, kind, children: [], childIndex: new Map() };
        siblingIndex.set(key, node);
        siblings.push(node);
      }
      parentPath = currentPath;
      siblings = node.children;
      siblingIndex = node.childIndex;
    }
  }

  const materialize = (nodes: MutableFileTreeNode[]): FileTreeNode[] => nodes
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      kind: node.kind,
      children: materialize(node.children),
      childrenLoaded: true
    }));
  return materialize(roots);
}
