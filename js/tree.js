/**
 * Generates an ASCII directory topology from a list of relative file paths.
 */
export function generateTree(paths) {
    const tree = Object.create(null);
    for (const path of paths) {
        let current = tree;
        for (const part of path.split('/')) {
            if (!Object.prototype.hasOwnProperty.call(current, part) || typeof current[part] !== 'object' || current[part] === null) {
                current[part] = Object.create(null);
            }
            current = current[part];
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

/**
 * Builds an interactive HTML DOM tree with selection checkboxes from a list of file nodes.
 */
function calculateDirSize(dirItem) {
    let sum = 0;
    if (!dirItem || !dirItem.children) return 0;
    for (const key of Object.keys(dirItem.children)) {
        const child = dirItem.children[key];
        if (child.isDir) {
            sum += calculateDirSize(child);
        } else {
            sum += child.size || 0;
        }
    }
    return sum;
}

function matchQuery(name, path, query) {
    if (!query) return true;
    const nameLower = name.toLowerCase();
    const pathLower = path.toLowerCase();
    const qLower = query.toLowerCase();

    // Handle glob extension syntax like *.js, *.py, .js
    if (qLower.startsWith('*.')) {
        const ext = qLower.slice(1); // e.g. .js
        return nameLower.endsWith(ext) || pathLower.endsWith(ext);
    }
    if (qLower.includes('*')) {
        const regexStr = '^' + qLower.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        try {
            const re = new RegExp(regexStr);
            return re.test(nameLower) || re.test(pathLower);
        } catch (_) {}
    }
    return nameLower.includes(qLower) || pathLower.includes(qLower);
}

const SVG_FOLDER = `<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const SVG_FILE = `<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
const SVG_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

export function renderInteractiveTree(nodes, container, onSelectionChange) {
    container.innerHTML = '';

    // Build hierarchy using prototype-safe objects
    const root = { name: '', isDir: true, children: Object.create(null), path: '' };

    for (const node of nodes) {
        const parts = node.path.split('/');
        let current = root;
        let currPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currPath = currPath ? `${currPath}/${part}` : part;
            const isLast = i === parts.length - 1;

            if (isLast && node.type === 'blob') {
                current.children[part] = {
                    name: part,
                    isDir: false,
                    path: node.path,
                    size: node.size || 0,
                    node: node
                };
            } else {
                if (!Object.prototype.hasOwnProperty.call(current.children, part)) {
                    current.children[part] = {
                        name: part,
                        isDir: true,
                        path: currPath,
                        children: Object.create(null)
                    };
                }
                current = current.children[part];
            }
        }
    }

    const selectedPaths = new Set(nodes.map(n => n.path));

    function createTreeNodeDOM(item) {
        const li = document.createElement('li');
        li.className = 'tree-item';

        const row = document.createElement('div');
        row.className = 'tree-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.className = 'tree-checkbox';

        const label = document.createElement('span');
        label.className = item.isDir ? 'tree-folder-label' : 'tree-file-label';
        label.innerHTML = (item.isDir ? SVG_FOLDER : SVG_FILE) + `<span>${item.name}</span>`;

        const sizeBadge = document.createElement('span');
        const bytes = item.isDir ? calculateDirSize(item) : (item.size || 0);
        const kbStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
        const estTok = Math.round(bytes / 3.8);
        const isLarge = !item.isDir && bytes > 50 * 1024; // 50 KB warning
        sizeBadge.className = 'tree-size-badge' + (isLarge ? ' tree-large-warning' : '');
        sizeBadge.textContent = ` (${kbStr} ~${estTok.toLocaleString()} tok)`;

        row.appendChild(checkbox);
        row.appendChild(label);
        row.appendChild(sizeBadge);
        li.appendChild(row);

        if (item.isDir) {
            const toggleBtn = document.createElement('span');
            toggleBtn.className = 'tree-toggle-icon';
            toggleBtn.innerHTML = SVG_CHEVRON_DOWN;
            row.insertBefore(toggleBtn, label);

            const ul = document.createElement('ul');
            ul.className = 'tree-children';

            let isExpanded = true;
            const toggleExpand = (expand) => {
                isExpanded = typeof expand === 'boolean' ? expand : !isExpanded;
                ul.style.display = isExpanded ? 'block' : 'none';
                toggleBtn.innerHTML = isExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_RIGHT;
            };

            label.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleExpand();
            });
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleExpand();
            });

            const childKeys = Object.keys(item.children).sort((a, b) => {
                const aIsDir = item.children[a].isDir;
                const bIsDir = item.children[b].isDir;
                if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                return a.localeCompare(b);
            });

            const childElements = [];
            for (const key of childKeys) {
                const childItem = item.children[key];
                const childDOM = createTreeNodeDOM(childItem);
                ul.appendChild(childDOM.li);
                childElements.push(childDOM);
            }

            li.appendChild(ul);

            checkbox.addEventListener('change', () => {
                const isChecked = checkbox.checked;
                for (const child of childElements) {
                    child.setSubtreeChecked(isChecked);
                }
                updateSelectionState();
            });

            return {
                li,
                checkbox,
                isDir: true,
                path: item.path,
                name: item.name,
                setSubtreeChecked(val, onlyVisible = false) {
                    if (onlyVisible && li.style.display === 'none') return;
                    checkbox.checked = val;
                    for (const child of childElements) {
                        child.setSubtreeChecked(val, onlyVisible);
                    }
                },
                updateStateFromChildren() {
                    let allChecked = true;
                    let noneChecked = true;
                    for (const child of childElements) {
                        child.updateStateFromChildren();
                        if (child.checkbox.checked) noneChecked = false;
                        else allChecked = false;
                    }
                    checkbox.checked = !noneChecked;
                    checkbox.indeterminate = !allChecked && !noneChecked;
                },
                collectSelectedFiles(acc) {
                    for (const child of childElements) {
                        child.collectSelectedFiles(acc);
                    }
                },
                deselectIfLargerThan(thresholdBytes) {
                    for (const child of childElements) {
                        if (child.deselectIfLargerThan) child.deselectIfLargerThan(thresholdBytes);
                    }
                },
                expandAll(val) {
                    toggleExpand(val);
                    for (const child of childElements) {
                        if (child.expandAll) child.expandAll(val);
                    }
                },
                applyFilter(query) {
                    let hasMatchingChild = false;
                    for (const child of childElements) {
                        const matches = child.applyFilter(query);
                        if (matches) hasMatchingChild = true;
                    }
                    const selfMatches = matchQuery(item.name, item.path, query);
                    const isVisible = !query || selfMatches || hasMatchingChild;
                    li.style.display = isVisible ? 'block' : 'none';
                    if (query && isVisible) toggleExpand(true);
                    return isVisible;
                }
            };
        } else {
            checkbox.addEventListener('change', () => {
                updateSelectionState();
            });

            return {
                li,
                checkbox,
                isDir: false,
                path: item.path,
                name: item.name,
                setSubtreeChecked(val, onlyVisible = false) {
                    if (onlyVisible && li.style.display === 'none') return;
                    checkbox.checked = val;
                },
                deselectIfLargerThan(thresholdBytes) {
                    if (!item.isDir && item.size > thresholdBytes) {
                        checkbox.checked = false;
                    }
                },
                updateStateFromChildren() {},
                collectSelectedFiles(acc) {
                    if (checkbox.checked) {
                        acc.push(item.node);
                    }
                },
                applyFilter(query) {
                    const matches = !query || matchQuery(item.name, item.path, query);
                    li.style.display = matches ? 'block' : 'none';
                    return matches;
                }
            };
        }
    }

    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';

    const rootChildKeys = Object.keys(root.children).sort((a, b) => {
        const aIsDir = root.children[a].isDir;
        const bIsDir = root.children[b].isDir;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b);
    });

    const rootNodes = [];
    for (const key of rootChildKeys) {
        const childDOM = createTreeNodeDOM(root.children[key]);
        rootUl.appendChild(childDOM.li);
        rootNodes.push(childDOM);
    }

    container.appendChild(rootUl);

    function getSelectedNodes() {
        const selected = [];
        for (const rn of rootNodes) {
            rn.collectSelectedFiles(selected);
        }
        return selected;
    }

    function updateSelectionState() {
        for (const rn of rootNodes) {
            rn.updateStateFromChildren();
        }
        if (onSelectionChange) {
            onSelectionChange(getSelectedNodes());
        }
    }

    let currentQuery = '';

    function getSelectedStats() {
        const selected = getSelectedNodes();
        let totalBytes = 0;
        for (const n of selected) {
            totalBytes += n.size || 0;
        }
        const estTokens = Math.round(totalBytes / 3.8);
        return { count: selected.length, bytes: totalBytes, estTokens };
    }

    return {
        getSelectedNodes,
        getSelectedStats,
        selectAll(val) {
            const hasFilter = Boolean(currentQuery);
            for (const rn of rootNodes) {
                rn.setSubtreeChecked(val, hasFilter);
            }
            updateSelectionState();
        },
        deselectLarge(thresholdBytes) {
            for (const rn of rootNodes) {
                if (rn.deselectIfLargerThan) rn.deselectIfLargerThan(thresholdBytes);
            }
            updateSelectionState();
        },
        expandAll(val) {
            for (const rn of rootNodes) {
                if (rn.expandAll) rn.expandAll(val);
            }
        },
        filter(query) {
            currentQuery = (query || '').trim();
            for (const rn of rootNodes) {
                rn.applyFilter(currentQuery);
            }
        }
    };
}
