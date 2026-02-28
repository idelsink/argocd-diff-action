import { expect, test, describe } from '@jest/globals';
import { buildCommentBodies, GITHUB_COMMENT_LIMIT } from '../src/main.js';
import { type Diff } from '../src/Diff.js';
import { type App } from '../src/argocd/App.js';

function makeApp(name: string): App {
    return {
        metadata: { name },
        spec: {
            source: {
                repoURL: `https://github.com/example/${name}`,
                path: `apps/${name}/overlays/local`,
                targetRevision: 'HEAD',
                helm: {},
                kustomize: {},
            },
        },
        status: { sync: { status: 'Synced' } },
    } as App;
}

function makeResource(name: string, lines = 5): string {
    return `===== /ConfigMap default/${name} ======\n` + Array.from({ length: lines }, (_, i) => `< line${i}: value`).join('\n') + '\n';
}

const HEADER = '## ArgoCD Diff\n\n_Updated at now_ PT\n';
const LEGEND = '\n| Legend | Status |\n| :---:  | :---   |\n| ✅ | synced |\n';
const URI = 'http://argocd.example';

describe('buildCommentBodies', () => {
    test('returns empty array when diffs is empty', () => {
        const result = buildCommentBodies([], HEADER, LEGEND, URI);
        expect(result).toEqual([]);
    });

    test('returns a single comment for a small diff', () => {
        const diff: Diff = {
            app: makeApp('my-app'),
            diff: makeResource('my-config'),
        };
        const result = buildCommentBodies([diff], HEADER, LEGEND, URI);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('my-app');
        expect(result[0]).toContain('my-config');
        expect(result[0]).toContain(HEADER);
        expect(result[0]).toContain(LEGEND);
    });

    test('all comments start with the header and end with the legend', () => {
        const diffs: Diff[] = Array.from({ length: 3 }, (_, i) => ({
            app: makeApp(`app-${i}`),
            diff: makeResource(`config-${i}`),
        }));
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        for (const body of result) {
            expect(body.startsWith(HEADER)).toBe(true);
            expect(body.endsWith(LEGEND)).toBe(true);
        }
    });

    test('each comment body is within the github limit', () => {
        // Create enough apps that they cannot all fit in one comment
        const bigResource = makeResource('big', 200);
        const diffs: Diff[] = Array.from({ length: 50 }, (_, i) => ({
            app: makeApp(`app-${i}`),
            diff: bigResource,
        }));
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result.length).toBeGreaterThan(1);
        for (const body of result) {
            expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
        }
    });

    test('splits apps across multiple comments when total exceeds limit', () => {
        // Each app diff is large enough that only ~1 fits per comment
        const largeResource = 'x'.repeat(Math.floor(GITHUB_COMMENT_LIMIT * 0.6));
        const diffs: Diff[] = [
            { app: makeApp('app-a'), diff: largeResource },
            { app: makeApp('app-b'), diff: largeResource },
        ];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result.length).toBe(2);
        expect(result[0]).toContain('app-a');
        expect(result[1]).toContain('app-b');
    });

    test('does not duplicate apps across comments', () => {
        const diffs: Diff[] = Array.from({ length: 4 }, (_, i) => ({
            app: makeApp(`app-${i}`),
            diff: makeResource(`config-${i}`),
        }));
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        const allContent = result.join('\n');
        for (let i = 0; i < 4; i++) {
            const matches = allContent.match(new RegExp(`app-${i}`, 'g'));
            // App name appears in the link and the app header line — just ensure it's present
            expect(matches).not.toBeNull();
        }
        // Each app should appear in exactly one comment
        for (let i = 0; i < 4; i++) {
            const appearsIn = result.filter(body => body.includes(`app-${i}`));
            expect(appearsIn).toHaveLength(1);
        }
    });

    test('truncates a single app diff that exceeds the limit and adds truncation notice', () => {
        // Build a diff with many resources so the full diff exceeds the limit
        const resources = Array.from({ length: 100 }, (_, i) => makeResource(`res-${i}`, 50));
        const hugeDiff = resources.join('');
        expect(hugeDiff.length).toBeGreaterThan(GITHUB_COMMENT_LIMIT);

        const diffs: Diff[] = [{ app: makeApp('big-app'), diff: hugeDiff }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);

        expect(result).toHaveLength(1);
        expect(result[0]!.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
        expect(result[0]).toContain('⚠️ Diff truncated');
        expect(result[0]).toContain('argocd app diff big-app --local-repo-root=. --local=');
    });

    test('truncation notice shows correct resource counts', () => {
        const resources = Array.from({ length: 100 }, (_, i) => makeResource(`res-${i}`, 50));
        const hugeDiff = resources.join('');

        const diffs: Diff[] = [{ app: makeApp('big-app'), diff: hugeDiff }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);

        // Should mention total of 100 resources
        expect(result[0]).toMatch(/showing \d+\/100 resources/);
    });

    test('no diff renders without details block', () => {
        const diffs: Diff[] = [{ app: makeApp('no-diff-app'), diff: '' }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('no-diff-app');
        expect(result[0]).not.toContain('<details>');
    });

    test('error diff renders stderr and command', () => {
        const diffs: Diff[] = [{
            app: makeApp('err-app'),
            diff: '',
            error: {
                stdout: '',
                stderr: 'something went wrong',
                err: new Error('exit 1'),
            },
        }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('something went wrong');
        expect(result[0]).toContain('Error 🛑');
    });

    test('out-of-sync app shows warning emoji', () => {
        const app = makeApp('oos-app');
        app.status.sync.status = 'OutOfSync';
        const diffs: Diff[] = [{ app, diff: makeResource('some-config') }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result[0]).toContain('Out of Sync ⚠️');
    });

    test('synced app shows synced checkmark', () => {
        const diffs: Diff[] = [{ app: makeApp('synced-app'), diff: makeResource('some-config') }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result[0]).toContain('Synced ✅');
    });

    test('diff is wrapped in a details block', () => {
        const diffs: Diff[] = [{ app: makeApp('my-app'), diff: makeResource('my-config') }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result[0]).toContain('<details>');
        expect(result[0]).toContain('</details>');
        expect(result[0]).toContain('```diff');
    });

    test('truncated diff still fits in one comment even when first resource is skipped', () => {
        // First resource alone plus overhead would exceed the limit — result should show 0 resources
        const hugeResource = makeResource('giant', 0) + 'x'.repeat(GITHUB_COMMENT_LIMIT);
        const diffs: Diff[] = [{ app: makeApp('giant-app'), diff: hugeResource }];
        const result = buildCommentBodies(diffs, HEADER, LEGEND, URI);
        expect(result).toHaveLength(1);
        expect(result[0]!.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
        expect(result[0]).toContain('⚠️ Diff truncated');
        expect(result[0]).toContain('showing 0/1 resources');
    });
});