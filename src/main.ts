import * as core from '@actions/core';
import * as github from '@actions/github';

export const GITHUB_COMMENT_LIMIT = 65536;
const DIFF_RESOURCE_SEPARATOR = /(?====== )/g;

import { type AppTargetRevision } from './argocd/AppTargetRevision.js';
import { ArgoCDServer } from './argocd/ArgoCDServer.js';
import { type Diff } from './Diff.js';
import { scrubSecrets } from './lib.js';
import getActionInput, { ActionInput } from './getActionInput.js';

run().catch((e) => {
    console.error(e);
    core.setFailed(e);
});

async function run(): Promise<void> {
    const actionInput = getActionInput();
    const argocdServer = new ArgoCDServer(actionInput);
    await argocdServer.installArgoCDCommand(actionInput.argocd.cliVersion, actionInput.arch);

    const appAllCollection = await argocdServer.getAppCollection();
    if (appAllCollection.apps == null) {
    // When the account used for the API key does not have at least read-only
    // access it will result in no Applications being returned.
        core.warning(
            'No Applications were returned from Argo CD. This may be the result of insufficient privileges.',
        );
        return;
    }
    // We can only run `diff --local` on files that are for this current repo.
    // Filter Apps to those following the repo trunk, since that is what the PR is
    // comparing against (in most cases).
    const appLocalCollection = appAllCollection
        .filterByRepo(`${github.context.repo.owner}/${github.context.repo.repo}`)
        .filterByTargetRevision(actionInput.argocd.targetRevisions)
        .filterByExcludedPath(actionInput.argocd.excludePaths);

    core.info(`Found apps: ${appLocalCollection.apps.map(a => a.metadata.name).join(', ')}`);

    const appDiffs = await argocdServer.getAppCollectionLocalDiffs(appLocalCollection);

    // Get diffs for apps of apps with targetRevision changes from local app diffs.
    // Note that this won't include any other changes to the App of App (e.g., Helm
    // value changes).
    const appOfAppTargetRevisions = getAppOfAppTargetRevisions(appDiffs);
    const appOfAppDiffs = await argocdServer.getAppCollectionRevisionDiffs(
        appAllCollection,
        appOfAppTargetRevisions,
    );

    await postDiffComment([...appDiffs, ...appOfAppDiffs], actionInput);
}

async function postDiffComment(diffs: Diff[], actionInput: ActionInput): Promise<void> {
    const octokit = github.getOctokit(actionInput.githubToken);
    const { owner, repo } = github.context.repo;
    const sha = github.context.payload.pull_request?.head?.sha;

    const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
    const shortCommitSha = String(sha).substring(0, 7);

    const legend = `
| Legend | Status |
| :---:  | :---   |
| ✅     | The app is synced in ArgoCD, and diffs you see are solely from this PR. |
| ⚠️      | The app is out-of-sync in ArgoCD, and the diffs you see include those changes plus any from this PR. |
| 🛑     | There was an error generating the ArgoCD diffs due to changes in this PR. |
`;

    const header = `## ArgoCD Diff ${actionInput.argocd.fqdn} for commit [\`${shortCommitSha}\`](${commitLink})

_Updated at ${new Date().toLocaleString('en-CA', { timeZone: actionInput.timezone })} PT_
`;

    const commentBodies = buildCommentBodies(diffs, header, legend, actionInput.argocd.uri);

    const numberedBodies = commentBodies.length > 1
        ? commentBodies.map((body, i) => body.replace(header, `${header}_${i + 1}/${commentBodies.length}_\n`))
        : commentBodies;

    const scrubbedBodies = numberedBodies.map(body =>
        scrubSecrets(body, actionInput.argocd.headers),
    );

    if (scrubbedBodies.length === 0) {
        return;
    }

    for (const body of scrubbedBodies) {
        await octokit.rest.issues.createComment({
            issue_number: github.context.issue.number,
            owner,
            repo,
            body,
        });
    }
}

export function buildCommentBodies(
    diffs: Diff[],
    header: string,
    legend: string,
    argocdUri: string,
): string[] {
    const wrapInDetails = (content: string) =>
        `\n<details>\n\n\`\`\`diff\n${content}\n\`\`\`\n\n</details>\n`;

    // Build each app's rendered block, truncating the diff if it alone exceeds the limit
    const appBlocks = diffs.map(({ app, diff, error }) => {
        const appHeader = `App: [\`${app.metadata.name}\`](${argocdUri}/applications/${app.metadata.name})
YAML generation: ${error ? ' Error 🛑' : 'Success 🟢'}
App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️ '}
`;

        const errorBlock = error
            ? `
**\`stderr:\`**
\`\`\`
${error.stderr}
\`\`\`

**\`command:\`**
\`\`\`json
${JSON.stringify(error.err)}
\`\`\`
`
            : '';

        if (!diff) {
            return `${appHeader}${errorBlock}\n---\n`;
        }

        const totalResources = diff.split(DIFF_RESOURCE_SEPARATOR).filter(Boolean).length;

        const truncationNotice = (shown: number) =>
            `\n> ⚠️ Diff truncated (showing ${shown}/${totalResources} resources). Run locally to see the full diff:\n> \`argocd app diff ${app.metadata.name} --local-repo-root=. --local=${app.spec.source?.path}\`\n`;

        const baseBlock = `${appHeader}${errorBlock}${wrapInDetails(diff)}\n---\n`;

        if ((header + baseBlock + legend).length <= GITHUB_COMMENT_LIMIT) {
            return baseBlock;
        }

        // Truncate: fit as many whole resources as possible within the limit
        const resources = diff.split(DIFF_RESOURCE_SEPARATOR).filter(Boolean);
        let truncatedDiff = '';
        let shownResources = 0;
        for (const resource of resources) {
            const candidate = truncatedDiff + resource;
            const candidateBlock = `${appHeader}${errorBlock}${wrapInDetails(candidate)}${truncationNotice(shownResources + 1)}\n---\n`;
            if ((header + candidateBlock + legend).length > GITHUB_COMMENT_LIMIT) {
                break;
            }
            truncatedDiff = candidate;
            shownResources++;
        }
        return `${appHeader}${errorBlock}${wrapInDetails(truncatedDiff)}${truncationNotice(shownResources)}\n---\n`;
    });

    // Pack app blocks into as few comments as possible, splitting when a comment would exceed the limit
    const commentBodies: string[] = [];
    let currentBody = header;
    for (const block of appBlocks) {
        const candidate = currentBody + block;
        if (candidate.length + legend.length > GITHUB_COMMENT_LIMIT && currentBody !== header) {
            // Adding this block would overflow — flush current and start a new comment
            commentBodies.push(currentBody + legend);
            currentBody = header + block;
        } else {
            // Either it fits, or this is the only block in the comment (already truncated above)
            currentBody = candidate;
        }
    }
    if (currentBody !== header) {
        commentBodies.push(currentBody + legend);
    }

    return commentBodies;
}

function getAppOfAppTargetRevisions(diffs: Diff[]): AppTargetRevision[] {
    const appTargetRevisions: AppTargetRevision[] = [];
    diffs.forEach((appDiff) => {
    // Check for diffs of an Application (App of App).
        if (appDiff.diff.includes('argoproj.io/Application')) {
            core.debug(`Found Application in the diff for Application '${appDiff.app.metadata.name}'.`);
            const changedResourceDiffs = appDiff.diff.split('===== ([\\w\\S]+/[\\w\\S]+ ){2}======');

            changedResourceDiffs.forEach(async (diff) => {
                const match = diff.match(
                    '===== (?:argoproj.io\\/Application) (\\w+/\\S+) ======\\n(?:.*\\n)*>\\s+targetRevision: (.*)',
                );
                if (match) {
                    const appName = match[1]?.split('/')[1] ?? 'undefined';
                    const targetRevision = match[2] ?? 'undefined';
                    core.info(
                        `Found targetRevision change on Application '${appName}' of Application '${appDiff.app.metadata.name}'.`,
                    );
                    appTargetRevisions.push({ appName: appName, targetRevision: targetRevision });
                }
            });
        }
        else {
            core.debug(
                `No targetRevision change found in Applications of Application '${appDiff.app.metadata.name}'.`,
            );
        }
    });
    return appTargetRevisions;
}
