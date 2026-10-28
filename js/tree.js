/**
 * Generates an ASCII directory topology from a list of relative file paths.
 */
export function generateTree(paths) {
    const tree = {};
    for (const path of paths) {
        let current = tree;
        for (const part of path.split('/')) {
            current = current[part] = current[part] || {};
        }
    }

    function print(node, prefix = '') {
        let out = '';
        const keys = Object.keys(node);
        keys.forEach((k, idx) => {
            const isLast = idx === keys.length - 1;
            out += `${prefix}${isLast ? '└── ' : '├── '}${k}\n`;
            out += print(node[k], prefix + (isLast ? '    ' : '│   '));
        });
        return out;
    }

    return print(tree);
}
