#!/usr/bin/env node
/**
 * `quick-acp-login` — sign in to Quick without the official desktop app.
 *
 *   node dist/login-cli.js --start-url https://ssoins-xxxx.awsapps.com/start
 *
 * Prints the sign-in URL, waits for the browser callback on 127.0.0.1:18080,
 * exchanges the code, and writes a profile the outpost can use.
 *
 * Nothing here needs the Electron shell; the only requirement is a browser and
 * an AWS account that has Quick access.
 */
import { login, issuerFromStartUrl, quickworkHome } from './quick/login.js';
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
        return process.argv[i + 1];
    }
    const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : undefined;
}
async function main() {
    const startUrl = arg('start-url') ?? arg('startUrl') ?? process.env.QUICK_ACP_START_URL;
    if (!startUrl) {
        console.error('quick-acp login');
        console.error('');
        console.error('Usage:');
        console.error('  node dist/login-cli.js --start-url https://ssoins-xxxxx.awsapps.com/start');
        console.error('');
        console.error('Where to find that URL:');
        console.error('  1. Open https://quicksight.aws.amazon.com (or any AWS console page) and sign in');
        console.error('  2. Your browser lands on your AWS access portal, at an address like');
        console.error('       https://ssoins-1a2b3c4d5e6f.awsapps.com/start');
        console.error('  3. Copy that whole address and pass it here');
        console.error('');
        console.error('Already signed into the desktop app? You do not need this command at all —');
        console.error('the bridge reads the stored login on its own.');
        process.exitCode = 1;
        return;
    }
    const issuer = issuerFromStartUrl(startUrl);
    console.log('quick-acp: sign in to Quick');
    console.log('');
    console.log('  start URL :', startUrl);
    console.log('  issuer    :', issuer ?? '(unrecognised)');
    console.log('  profiles  :', quickworkHome());
    console.log('');
    if (!issuer) {
        console.error('That does not look like an AWS access portal URL.');
        console.error('Expected: https://ssoins-xxxxx.awsapps.com/start');
        process.exitCode = 1;
        return;
    }
    const result = await login({
        startUrl,
        persist: true,
        onUrl: (url) => {
            console.log('Open this in your browser and sign in:');
            console.log('');
            console.log('  ' + url);
            console.log('');
            console.log('Waiting for the sign-in to finish...');
            console.log('');
        },
    });
    console.log('');
    if (!result.ok) {
        console.error('sign-in FAILED:', result.error);
        process.exitCode = 1;
        return;
    }
    console.log('Signed in.');
    console.log('  client id   :', result.clientId);
    console.log('  access token:', result.accessToken ? `${result.accessToken.slice(0, 24)}…` : '(none)');
    console.log('  refresh tok :', result.refreshToken ? `${result.refreshToken.slice(0, 24)}…` : '(none)');
    console.log('  expires at  :', result.expiresAt ? new Date(result.expiresAt * 1000).toISOString() : '?');
    console.log('  profile     :', result.profilePath);
    console.log('');
    console.log('Next: start the outpost with QUICK_ACP_QUICKWORK_HOME pointing at');
    console.log('the directory holding that profiles.json, then run the bridge as usual.');
}
void main().catch((e) => {
    console.error('fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
});
//# sourceMappingURL=login-cli.js.map