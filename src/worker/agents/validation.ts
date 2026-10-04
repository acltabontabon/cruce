/** Keep the test process's status; a tail pipeline would report tail's exit status instead. */
export const TEST_COMMAND = 'timeout 300 npm test >"$1" 2>&1; test_exit=$?; tail -40 "$1"; exit "$test_exit"';

export function validationResult(exitCode: number, output: string): { passed: boolean; summary: string } {
	const pass = /ℹ pass (\d+)/.exec(output)?.[1];
	const fail = /ℹ fail (\d+)/.exec(output)?.[1];
	const counts = pass === undefined ? "" : `${pass} passed, ${fail ?? "?"} failed; `;
	const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 200);
	return {
		passed: exitCode === 0,
		summary: `${counts}${exitCode === 124 ? "test command timed out" : `test command exited ${exitCode}`} (npm test in sandbox)${counts || !tail ? "" : `: ${tail}`}`,
	};
}
