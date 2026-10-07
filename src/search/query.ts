import { normalizeText } from '../indexing/document';

export interface QueryPlan {
	terms: string[];
	phrases: string[];
	paths: string[];
	tags: string[];
	text: string;
}

export function parseQuery(input: string): QueryPlan {
	if (input.length > 1000) throw new Error('Use a query shorter than 1,000 characters.');
	const plan: QueryPlan = { terms: [], phrases: [], paths: [], tags: [], text: '' };
	const text: string[] = [];
	let rest = input.trim();
	while (rest) {
		const match = /^(?:(path|tag):)?(?:"([^"]*)"|([^\s"]+))(?=\s|$)/i.exec(rest);
		if (!match) throw new Error('Close each double quote and separate terms with spaces.');
		const value = (match[2] ?? match[3] ?? '').trim();
		if (!value || /^(path|tag):$/i.test(value)) throw new Error('Enter text inside quotes or after a filter.');
		if (match[1]?.toLowerCase() === 'path') plan.paths.push(value.toLowerCase());
		else if (match[1]?.toLowerCase() === 'tag') plan.tags.push(value.replace(/^#/, '').toLowerCase());
		else {
			text.push(value);
			if (match[2] !== undefined) plan.phrases.push(value);
			else plan.terms.push(value);
		}
		rest = rest.slice(match[0].length).trimStart();
	}
	if (plan.terms.length + plan.phrases.length > 32) throw new Error('Use at most 32 search terms.');
	plan.text = normalizeText(text.join(' '));
	return plan;
}

export function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function queryFilter(plan: QueryPlan): string | undefined {
	const conditions = plan.paths.map((path) => `contains(lower(path), ${sqlString(path)})`);
	for (const tag of plan.tags) {
		// Tags are delimited, so #book cannot accidentally match #notebook.
		conditions.push(`contains(tagFilter, ${sqlString(`\n${tag}\n`)})`);
	}
	return conditions.length ? conditions.join(' AND ') : undefined;
}

export function phrasePattern(phrase: string): RegExp {
	return new RegExp(phrase.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iu');
}
