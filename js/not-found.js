/**
 * 404 page: a GitHub-style repository path (gitdoco.../owner/repo/issues) opens the matching tool;
 * a bare /owner/repo shows a page to pick one (js/repo-route.js). Anything else is a real 404.
 */
import { routeFor, toolLinks } from './repo-route.js';

const route = routeFor(window.location.pathname);
if (route && route.href) {
    window.location.replace(route.href);
} else if (route && route.hub) {
    const links = toolLinks(route.repo);
    const set = (id, href) => { const a = document.getElementById(id); if (a) a.href = href; };
    document.getElementById('hubRepo').textContent = route.repo;
    set('hubDeps', links.deps);
    set('hubIssues', links.issues);
    set('hubDiscussions', links.discussions);
    set('hubCode', links.code);
    set('hubGithub', `https://github.com/${route.repo}`);
    document.title = `${route.repo}: GitDoco`;
    document.getElementById('notFound').hidden = true;
    document.getElementById('repoHub').hidden = false;
}
