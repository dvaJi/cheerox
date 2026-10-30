import * as rusteerio from 'cheerox/modern';
import type { Cheerio, CheerioAPI, CheerioOptions, CheerioRequestOptions, load as cheerioLoad, fromURL as cheerioFromURL } from 'cheerio';
import * as rusteerioSlim from 'cheerox/slim';

// @ts-expect-error Cheerio is exported only as a type, as in upstream Cheerio.
void rusteerio.Cheerio;
// @ts-expect-error The internal DOM enum is exported only as a type.
void rusteerio.ElementType;
// @ts-expect-error Slim also keeps Cheerio as a type-only export.
void rusteerioSlim.Cheerio;
// @ts-expect-error Use rusteerio.dom.ElementType for runtime DOM constants.
void rusteerioSlim.ElementType;

const load: typeof cheerioLoad = rusteerio.load;
const fetchDocument: typeof cheerioFromURL = rusteerio.fromURL;
declare const httpOptions: CheerioRequestOptions;
const compatibleHTTPOptions: rusteerio.CheerioRequestOptions = httpOptions;
void [fetchDocument, compatibleHTTPOptions];
const options: CheerioOptions = { baseURI: 'https://example.com' };
const $: CheerioAPI = load('<h1>Hello</h1>', options);
const text: string = $('h1').text();
const workerInfo: rusteerio.WorkerPoolInfo = rusteerio.workerPoolInfo();
const workerBudget: number = workerInfo.threads;
const configure: (options: number | rusteerio.WorkerOptions) => rusteerio.WorkerPoolInfo = rusteerio.configureWorkers;
const nativeElement = new rusteerio.dom.Element('p', { id: 'typed' });
const scriptElement = new rusteerio.dom.Element('script', {}, [], rusteerio.dom.ElementType.Script);
const nativeNodeType: typeof nativeElement.type = rusteerio.dom.ElementType.Tag;
const nativeNode: rusteerio.AnyNode = nativeElement;
void [workerBudget, configure, nativeNode, scriptElement, nativeNodeType];
$('h1').attr('id', (_, old) => old ?? 'title').addClass('heading');
const asyncDoc: CheerioAPI = await rusteerio.loadAsync('<h1>Async</h1>');
const docs: CheerioAPI[] = await rusteerio.loadAll(['<h1>A</h1>'], { threads: 2 });
const results = await rusteerio.extractAll(['<h1>A</h1>'], { titles: ['h1'], title: 'h1' }, { threads: 2 });
const titles: string[] = results[0].titles;
const title: string | undefined = results[0].title;
const detailed = await rusteerio.extractAll(['<article><h1>A</h1></article>'], {
  article: { selector: 'article', value: { title: 'h1' } },
  lengths: [{ selector: 'h1', value: (element) => element.name.length }],
});
const nestedTitle: string | undefined = detailed[0].article?.title;
const lengths: number[] = detailed[0].lengths;
const extracted = rusteerio.load('<article><h1>A</h1></article>').extract({
  titles: ['h1'],
  title: 'h1',
  article: { selector: 'article', value: { title: 'h1' } },
  lengths: [{ selector: 'h1', value: (element) => {
    const name: string = element.name;
    // @ts-expect-error Extract callbacks receive typed DOM elements.
    const invalid: number = element.name;
    void invalid;
    return name.length;
  } }],
});
const extractedTitles: string[] = extracted.titles;
const extractedTitle: string | undefined = extracted.title;
const extractedNestedTitle: string | undefined = extracted.article?.title;
const extractedLengths: number[] = extracted.lengths;
// @ts-expect-error Precise extraction output never falls back to any.
const invalidExtraction: number[] = extracted.titles;
const typedSelection = rusteerio.load('<h1>A</h1>')('h1');
const element: rusteerio.Element = typedSelection[0];
const selectedExtraction = typedSelection.extract({ values: [':scope'], lengths: [{ selector: ':scope', value: (node) => node.name.length }] });
const selectedValues: string[] = selectedExtraction.values;
const selectedLengths: number[] = selectedExtraction.lengths;
// @ts-expect-error Selection extract also retains its precise overload.
const invalidSelected: boolean[] = selectedExtraction.values;
declare const nativeExtractReturn: ReturnType<rusteerio.Cheerio['extract']>;
declare const upstreamExtractReturn: ReturnType<Cheerio<unknown>['extract']>;
const upstreamReturn: typeof upstreamExtractReturn = nativeExtractReturn;
const nativeReturn: typeof nativeExtractReturn = upstreamExtractReturn;
void [text, asyncDoc, docs, titles, title, nestedTitle, lengths, extractedTitles, extractedTitle, extractedNestedTitle, extractedLengths, invalidExtraction, element, selectedValues, selectedLengths, invalidSelected, upstreamReturn, nativeReturn];
