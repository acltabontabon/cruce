import { SCOPE_LABELS, SCOPES, type Scope } from "../core/capabilities.ts";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const permissions: Record<Scope, string> = {
	"cruce:read": "Read repositories and work history",
	"workspace:write": "Create workspaces and report progress",
	"revision:publish": "Publish Git revisions",
	"artifact:publish": "Save evidence for revisions",
	"change:write": "Propose and review changes",
	"promotion:request": "Request human approval to promote",
};
const styles = `
*{box-sizing:border-box}html{color-scheme:light;background:#f5f5ef}body{margin:0;color:#17251f;font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:#346345;text-underline-offset:4px}button,input{font:inherit}button,a,input,summary{ -webkit-tap-highlight-color:transparent} :focus-visible{outline:3px solid #346345;outline-offset:4px}
header{max-width:1040px;margin:auto;padding:24px 32px} .brand{display:inline-flex;align-items:center;gap:10px;color:#17251f;text-decoration:none;font-size:21px;font-weight:650;letter-spacing:-.8px}.brand img{width:30px;height:30px}
main{width:min(100% - 40px,600px);margin:8px auto 44px}.eyebrow{font-size:12px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:#5c695f}h1{font-size:34px;line-height:1.15;letter-spacing:-1.3px;margin:12px 0 16px;font-weight:600}p{margin:0 0 16px}.intro{font-size:16px;color:#5c695f}.intro strong{color:#17251f;font-weight:600;overflow-wrap:anywhere}.account{display:flex;gap:10px;align-items:center;font-size:13px;color:#5c695f;margin:16px 0 22px}.account span{overflow-wrap:anywhere}.account .dot{width:7px;height:7px;border-radius:50%;background:#346345;flex:none}
fieldset{border:0;margin:0;padding:0;min-width:0}legend{font-size:17px;font-weight:600;padding:0;margin-bottom:5px}.hint{color:#5c695f;font-size:13px;margin-bottom:14px}.search{display:block;width:100%;border:1px solid #d4dacf;border-radius:8px;padding:11px 13px;background:#fff;margin-bottom:12px;color:#17251f}.repositories{border:1px solid #d4dacf;border-radius:10px;background:#fff;max-height:240px;overflow:auto}.repository{display:flex;gap:13px;align-items:center;padding:10px 16px;cursor:pointer;border-bottom:1px solid #e5e8df}.repository:last-child{border-bottom:0}.repository:hover{background:#f8faf4}.repository:has(:checked){background:#edf5e6}.repository:focus-within{box-shadow:inset 3px 0 #346345}input[type=checkbox]{width:17px;height:17px;margin:0;flex:none;accent-color:#346345;cursor:pointer}.repository span{overflow-wrap:anywhere;min-width:0;font-size:14px}.repository small{display:block;color:#5c695f;font-size:12px}.repository strong{font-weight:600}.selection{font-size:12px;color:#5c695f;margin:8px 0 16px}.empty{padding:18px;color:#5c695f;margin:0}.empty a{display:inline-block;margin-top:8px}
details{border-top:1px solid #d4dacf;padding:14px 0}summary{cursor:pointer;font-weight:550;display:list-item;list-style-position:inside}summary span{float:right;color:#5c695f;font-size:12px;font-weight:400;margin-top:3px}.permission-list{margin-top:15px;display:grid;gap:12px}.permission{display:flex;align-items:center;gap:12px;font-size:14px;cursor:pointer}.permission small{margin-left:auto;color:#5c695f;font-size:12px}.technical{font-size:12px;color:#5c695f;margin-top:14px}.technical p{margin-bottom:12px;overflow-wrap:anywhere}.technical ul{padding-left:18px}.technical code{font-size:11px}.guardrail{display:flex;gap:12px;padding:16px;background:#eaf0e3;border-radius:8px;margin:8px 0 24px;font-size:13px;color:#3c5141}.guardrail svg{width:20px;height:20px;flex:none;margin-top:2px}.guardrail p{margin:0}.guardrail strong{display:block;color:#17251f;font-weight:600;margin-bottom:2px}.actions{display:flex;align-items:center;gap:18px;justify-content:flex-end;border-top:1px solid #d4dacf;padding-top:20px}.actions a{text-decoration:none;font-size:14px;padding:10px}.primary{border:1px solid #17251f;background:#17251f;color:#fff;border-radius:8px;padding:11px 20px;font-weight:550;cursor:pointer}.primary:hover{background:#2b4433}.primary:disabled{background:#e1e5db;border-color:#e1e5db;color:#687062;cursor:default}.footer{font-size:12px;color:#5c695f;margin-top:16px;text-align:right}[hidden]{display:none!important}
@media(max-width:600px){header{padding:22px 20px}main{margin-top:18px}h1{font-size:30px}.actions{justify-content:space-between}.primary{flex:1}.footer{text-align:left}summary span{float:none;margin-left:10px}}
`;
const script = `
const form = document.querySelector('form');
const repositories = [...form.querySelectorAll('input[name="repository"]')];
const button = form.querySelector('button');
const count = document.querySelector('#selection');
const search = document.querySelector('#search');
const update = () => {
 const selected = repositories.filter(input => input.type === 'hidden' || input.checked).length;
 button.disabled = !selected;
 if (count) count.textContent = selected ? selected + (selected === 1 ? ' repository selected' : ' repositories selected') : 'Select at least one repository to continue.';
 const enabled = form.querySelectorAll('input[name="scope"]:checked').length;
 document.querySelector('#permission-count').textContent = enabled + ' enabled';
};
form.addEventListener('change', update);
form.addEventListener('submit', event => { if (!repositories.some(input => input.type === 'hidden' || input.checked)) { event.preventDefault(); repositories[0]?.focus(); } });
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
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style nonce="${nonce}">${styles}</style></head><body><header><a class="brand" href="/" aria-label="Cruce home"><img src="/brand/symbol-ink.svg" alt="">Cruce</a></header><main>${body}</main>${javascript ? `<script nonce="${nonce}">${javascript}</script>` : ""}</body></html>`,
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
		boundRepository?: boolean;
	},
	headers: Headers,
) {
	const { repositories, preset, boundRepository } = input;
	const choices = repositories
		.map((repository) => {
			const separator = repository.label.indexOf("/");
			const namespace = separator < 0 ? "" : repository.label.slice(0, separator);
			const name = separator < 0 ? repository.label : repository.label.slice(separator + 1);
			if (boundRepository)
				return `<div class="repository"><input type="hidden" name="repository" value="${escapeHtml(repository.id)}"><span><small>${escapeHtml(namespace)}</small><strong>${escapeHtml(name)}</strong></span></div>`;
			return `<label class="repository"><input type="checkbox" name="repository" value="${escapeHtml(repository.id)}"><span><small>${escapeHtml(namespace)}</small><strong>${escapeHtml(name)}</strong></span></label>`;
		})
		.join("");
	const options = SCOPES.map(
		(scope) =>
			`<label class="permission"><input type="checkbox" name="scope" value="${scope}"${preset.includes(scope) || scope === "cruce:read" ? " checked" : ""}${scope === "cruce:read" ? " disabled" : ""}><span>${permissions[scope]}</span>${scope === "cruce:read" ? "<small>Required</small>" : ""}</label>`,
	).join("");
	return page(
		`<div class="eyebrow">Tool connection</div><h1>Connect to Cruce</h1><p class="intro"><strong>${escapeHtml(input.clientName)}</strong> ${boundRepository ? "wants access to this repository." : "wants access to your repositories. Choose which ones it can work with."}</p><div class="account"><i class="dot" aria-hidden="true"></i><span>Signed in as <strong>${escapeHtml(input.email)}</strong></span></div><form method="post"><input type="hidden" name="handle" value="${escapeHtml(input.handle)}"><fieldset><legend>${boundRepository ? "Repository access" : "Choose repositories"}</legend><p class="hint">${boundRepository ? "Access is limited to this repository." : "Only the repositories you select will be shared with this tool."}</p>${repositories.length ? `${boundRepository ? "" : `<div id="search-control" hidden><label class="hint" for="search">Find a repository</label><input class="search" id="search" type="search" placeholder="Search by name or namespace" autocomplete="off"></div>`}<div class="repositories">${choices}${boundRepository ? "" : `<p id="no-results" class="empty" hidden>No repositories match your search.</p>`}</div>` : `<div class="repositories"><p class="empty">You don’t have any repositories available to connect.<br><a href="/">Go to Home to create a repository or check your access</a></p></div>`}${boundRepository ? "" : `<p id="selection" class="selection" role="status">Select at least one repository to continue.</p>`}</fieldset><details><summary>Review permissions <span id="permission-count">${SCOPES.filter((scope) => preset.includes(scope) || scope === "cruce:read").length} enabled</span></summary><p class="hint">Applies ${boundRepository ? "to this repository" : "to the repositories you select"}, within your current access. Uncheck anything this tool doesn’t need.</p><fieldset aria-label="Tool permissions" class="permission-list">${options}</fieldset></details><details><summary>Connection details</summary><div class="technical"><p>Tool name is supplied by the client.</p><p>Return address<br><code>${escapeHtml(input.redirectUri)}</code></p><p>Permission identifiers</p><ul>${SCOPES.map((scope) => `<li><code>${scope}</code> — ${escapeHtml(SCOPE_LABELS[scope])}</li>`).join("")}</ul><p>Cloud operations may incur costs and remain subject to namespace resource policy.</p></div></details><div class="guardrail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg><p><strong>You stay in control</strong>Promoting changes to canonical Git still requires human approval. You can revoke this connection from Agent connections.</p></div><div class="actions"><a href="/">Cancel</a><button class="primary"${repositories.length ? "" : " disabled"}>Connect</button></div><p class="footer">You’ll return to your tool after connecting.</p></form>`,
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
