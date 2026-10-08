import { SCOPE_LABELS, SCOPES, type Scope } from "../core/capabilities.ts";
import { APPEARANCE_SCRIPT, MARK } from "../shared/brand.ts";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const permissions: Record<Scope, string> = {
	"cruce:read": "Read repositories and work history",
	"workspace:write": "Create workspaces and report progress",
	"revision:publish": "Publish Git revisions",
	"artifact:publish": "Save evidence for revisions",
	"change:write": "Propose and review changes",
	"promotion:request": "Request human approval to promote",
};
const mark = `<svg viewBox="${MARK.viewBox}" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK.arch}"/><path d="${MARK.crossing}"/></g></svg>`;
// The console's Daylight and Midnight tokens, so tool authorization looks like the console it grants access to.
const styles = `
:root{color-scheme:light;--bg:#f5f6f9;--surface:#fff;--border:#dce0e8;--border-subtle:#e7eaf0;--text:#151925;--muted:#535b70;--accent:#2c58d0;--accent-hover:#2149b5;--on-accent:#fff;--hover:#f1f3f7;--selected:#eef2fc;--selected-border:#a9bdf0;--note:#eef1f6;--button-disabled:#e7eaf0;--font:"Geist Variable",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono Variable",ui-monospace,"SF Mono",Menlo,monospace}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0f111a;--surface:#151826;--border:#2a2f46;--border-subtle:#1f2336;--text:#dce1f5;--muted:#9ca5c7;--accent:#82a6ff;--accent-hover:#a0bcff;--on-accent:#0b0d14;--hover:#1b1f30;--selected:#1a2140;--selected-border:#3d4f8a;--note:#1b1f30;--button-disabled:#262b42}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0f111a;--surface:#151826;--border:#2a2f46;--border-subtle:#1f2336;--text:#dce1f5;--muted:#9ca5c7;--accent:#82a6ff;--accent-hover:#a0bcff;--on-accent:#0b0d14;--hover:#1b1f30;--selected:#1a2140;--selected-border:#3d4f8a;--note:#1b1f30;--button-disabled:#262b42}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--text);font:15px/1.55 var(--font)}
a{color:var(--accent);text-underline-offset:4px}button,input{font:inherit}button,a,input,summary{ -webkit-tap-highlight-color:transparent} :focus-visible{outline:3px solid var(--accent);outline-offset:4px}
header{max-width:1040px;margin:auto;padding:24px 32px} .brand{display:inline-flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-family:var(--mono);font-size:17px;font-weight:650;letter-spacing:-.02em}.brand svg{width:24px;height:24px;color:var(--accent)}
main{width:min(100% - 40px,600px);margin:8px auto 44px}.eyebrow{font-size:12px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:34px;line-height:1.15;letter-spacing:-1.3px;margin:12px 0 16px;font-weight:600}p{margin:0 0 16px}.intro{font-size:16px;color:var(--muted)}.intro strong{color:var(--text);font-weight:600;overflow-wrap:anywhere}.account{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--muted);margin:16px 0 22px}.account span{overflow-wrap:anywhere}.account .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
fieldset{border:0;margin:0;padding:0;min-width:0}legend{font-size:17px;font-weight:600;padding:0;margin-bottom:5px}.hint{color:var(--muted);font-size:13px;margin-bottom:14px}.search{display:block;width:100%;border:1px solid var(--border);border-radius:8px;padding:11px 13px;background:var(--surface);margin-bottom:12px;color:var(--text)}.repositories{border:1px solid var(--border);border-radius:10px;background:var(--surface);max-height:240px;overflow:auto}.repository{display:flex;gap:13px;align-items:center;padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border-subtle)}.repository:last-child{border-bottom:0}.repository:hover{background:var(--hover)}.repository:has(:checked){background:var(--selected)}.repository:focus-within{box-shadow:inset 3px 0 var(--accent)}input[type=checkbox]{width:17px;height:17px;margin:0;flex:none;accent-color:var(--accent);cursor:pointer}.repository span{overflow-wrap:anywhere;min-width:0;font-size:14px}.repository small{display:block;color:var(--muted);font-size:12px}.repository strong{font-weight:600}.selection{font-size:12px;color:var(--muted);margin:8px 0 16px}.access{display:flex;gap:13px;align-items:flex-start;padding:12px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:10px;cursor:pointer}.access:has(:checked){background:var(--selected);border-color:var(--selected-border)}.access:focus-within{box-shadow:inset 3px 0 var(--accent)}.access input{margin:3px 0 0;accent-color:var(--accent);width:17px;height:17px;flex:none}.access span{font-size:14px}.access small{display:block;color:var(--muted);font-size:12px}.access strong{font-weight:600}.chooser{margin:4px 0 0 0}.empty{padding:18px;color:var(--muted);margin:0}.empty a{display:inline-block;margin-top:8px}
details{border-top:1px solid var(--border);padding:14px 0}summary{cursor:pointer;font-weight:550;display:list-item;list-style-position:inside}summary span{float:right;color:var(--muted);font-size:12px;font-weight:400;margin-top:3px}.permission-list{margin-top:15px;display:grid;gap:12px}.permission{display:flex;align-items:center;gap:12px;font-size:14px;cursor:pointer}.permission small{margin-left:auto;color:var(--muted);font-size:12px}.technical{font-size:12px;color:var(--muted);margin-top:14px}.technical p{margin-bottom:12px;overflow-wrap:anywhere}.technical ul{padding-left:18px}.technical code{font-size:11px}.guardrail{display:flex;gap:12px;padding:16px;background:var(--note);border-radius:8px;margin:8px 0 24px;font-size:13px;color:var(--muted)}.guardrail svg{width:20px;height:20px;flex:none;margin-top:2px}.guardrail p{margin:0}.guardrail strong{display:block;color:var(--text);font-weight:600;margin-bottom:2px}.actions{display:flex;align-items:center;gap:18px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:20px}.actions a{text-decoration:none;font-size:14px;padding:10px}.primary{border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);border-radius:8px;padding:11px 20px;font-weight:550;cursor:pointer}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.primary:disabled{background:var(--button-disabled);border-color:var(--button-disabled);color:var(--muted);cursor:default}.footer{font-size:12px;color:var(--muted);margin-top:16px;text-align:right}[hidden]{display:none!important}
@media(max-width:600px){header{padding:22px 20px}main{margin-top:18px}h1{font-size:30px}.actions{justify-content:space-between}.primary{flex:1}.footer{text-align:left}summary span{float:none;margin-left:10px}}
`;
const script = `
const form = document.querySelector('form');
const repositories = [...form.querySelectorAll('input[name="repository"]')];
const button = form.querySelector('button');
const count = document.querySelector('#selection');
const search = document.querySelector('#search');
const chooser = document.querySelector('#chooser');
const choosing = () => form.querySelector('input[name="access"]:checked')?.value === 'choose';
const update = () => {
 const selected = repositories.filter(input => input.checked).length;
 chooser.hidden = !choosing();
 for (const input of repositories) input.disabled = !choosing();
 button.disabled = choosing() && !selected;
 if (count) count.textContent = selected ? selected + (selected === 1 ? ' repository selected' : ' repositories selected') : 'Select at least one repository to continue.';
 const enabled = form.querySelectorAll('input[name="scope"]:checked').length;
 document.querySelector('#permission-count').textContent = enabled + ' enabled';
};
form.addEventListener('change', update);
form.addEventListener('submit', event => { if (choosing() && !repositories.some(input => input.checked)) { event.preventDefault(); repositories[0]?.focus(); } });
if (search) {
 document.querySelector('#search-control').hidden = false;
 search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  for (const input of repositories) input.closest('label').hidden = !input.closest('label').textContent.toLocaleLowerCase().includes(query);
  document.querySelector('#no-results').hidden = repositories.some(input => !input.closest('label').hidden);
 });
}
update();
`;
function page(body: string, title: string, headers: Headers, status = 200, javascript = "") {
	const nonce = crypto.randomUUID();
	headers.set("content-type", "text/html; charset=utf-8");
	headers.set("cache-control", "no-store");
	headers.set(
		"content-security-policy",
		`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
	);
	headers.set("referrer-policy", "no-referrer");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><script nonce="${nonce}">${APPEARANCE_SCRIPT}</script><style nonce="${nonce}">${styles}</style></head><body><header><a class="brand" href="/" aria-label="Cruce home">${mark}Cruce</a></header><main>${body}</main>${javascript ? `<script nonce="${nonce}">${javascript}</script>` : ""}</body></html>`,
		{ status, headers },
	);
}
export function consentPage(
	input: {
		clientName: string;
		email: string;
		handle: string;
		redirectUri: string;
		repositories: { id: string; label: string }[];
		preset: readonly Scope[];
	},
	headers: Headers,
) {
	const { repositories, preset } = input;
	const choices = repositories
		.map((repository) => {
			const separator = repository.label.indexOf("/");
			const namespace = separator < 0 ? "" : repository.label.slice(0, separator);
			const name = separator < 0 ? repository.label : repository.label.slice(separator + 1);
			return `<label class="repository"><input type="checkbox" name="repository" value="${escapeHtml(repository.id)}"><span><small>${escapeHtml(namespace)}</small><strong>${escapeHtml(name)}</strong></span></label>`;
		})
		.join("");
	const options = SCOPES.map(
		(scope) =>
			`<label class="permission"><input type="checkbox" name="scope" value="${scope}"${preset.includes(scope) || scope === "cruce:read" ? " checked" : ""}${scope === "cruce:read" ? " disabled" : ""}><span>${permissions[scope]}</span>${scope === "cruce:read" ? "<small>Required</small>" : ""}</label>`,
	).join("");
	const chooser = repositories.length
		? `<div id="search-control" hidden><label class="hint" for="search">Find a repository</label><input class="search" id="search" type="search" placeholder="Search by name or namespace" autocomplete="off"></div><div class="repositories">${choices}<p id="no-results" class="empty" hidden>No repositories match your search.</p></div><p id="selection" class="selection" role="status">Select at least one repository to continue.</p>`
		: `<div class="repositories"><p class="empty">You don’t have any repositories to choose yet.</p></div>`;
	return page(
		`<div class="eyebrow">Tool connection</div><h1>Connect to Cruce</h1><p class="intro"><strong>${escapeHtml(input.clientName)}</strong> wants access to your repositories. Connect once; it works in every repository you allow.</p><div class="account"><i class="dot" aria-hidden="true"></i><span>Signed in as <strong>${escapeHtml(input.email)}</strong></span></div><form method="post"><input type="hidden" name="handle" value="${escapeHtml(input.handle)}"><fieldset><legend>Repository access</legend><p class="hint">Access never exceeds your current namespace roles and repository grants.</p><label class="access"><input type="radio" name="access" value="all" checked><span><strong>All repositories you can access</strong><small>Includes repositories created or shared with you later.</small></span></label><label class="access"><input type="radio" name="access" value="choose"${repositories.length ? "" : " disabled"}><span><strong>Choose repositories</strong><small>Only the repositories you select.</small></span></label><div id="chooser" class="chooser">${chooser}</div></fieldset><details><summary>Review permissions <span id="permission-count">${SCOPES.filter((scope) => preset.includes(scope) || scope === "cruce:read").length} enabled</span></summary><p class="hint">Applies to the repositories this connection can reach, within your current access. Uncheck anything this tool doesn’t need.</p><fieldset aria-label="Tool permissions" class="permission-list">${options}</fieldset></details><details><summary>Connection details</summary><div class="technical"><p>Tool name is supplied by the client.</p><p>Return address<br><code>${escapeHtml(input.redirectUri)}</code></p><p>Permission identifiers</p><ul>${SCOPES.map((scope) => `<li><code>${scope}</code> — ${escapeHtml(SCOPE_LABELS[scope])}</li>`).join("")}</ul><p>Cloud operations may incur costs and remain subject to namespace resource policy.</p></div></details><div class="guardrail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg><p><strong>You stay in control</strong>Promoting changes to canonical Git still requires human approval. You can revoke this connection from Local setup.</p></div><div class="actions"><a href="/">Cancel</a><button class="primary">Connect</button></div><p class="footer">You’ll return to your tool after connecting.</p></form>`,
		"Connect to Cruce",
		headers,
		200,
		script,
	);
}
export function consentErrorPage(description: string, retryUrl: string) {
	return page(
		`<div class="eyebrow">Tool connection</div><h1>Connection not authorized</h1><p class="intro">${escapeHtml(description)}</p><div class="actions"><a href="/">Cancel</a><a class="primary" href="${escapeHtml(retryUrl)}">Start again</a></div>`,
		"Connection not authorized",
		new Headers(),
		400,
	);
}
