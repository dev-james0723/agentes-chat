import { splitWord, WORD } from "./cjk";

/**
 * Words too common to say what a text is about, in Portuguese and English (3+ letters: the search ignores shorter
 * ones). The search index uses Postgres's `simple` configuration, which keeps every word, so a retrieval query drops
 * these itself: otherwise "que", "para" or "with" match nearly every document.
 */
// ponytail: pt and en only, the languages most messages are written in; add a list per language when one is needed.
const PT = `
abaixo acima agora ainda alguma algumas algum alguns ali além antes aos apenas após aquela aquelas aquele aqueles
aqui aquilo assim até cada coisa com como contra contudo cuja cujas cujo cujos dar das dela delas dele deles demais
depois desde dessa dessas desse desses desta destas deste destes deve devem dia dias diz dizer dois dos duas durante
ela elas ele eles então entre era eram essa essas esse esses esta estamos estas estava estavam este esteja estes
estou está estão eu fazer faz fez foi for foram fosse fui havia hoje isso isto já lhe lhes logo mais mas me mesma
mesmas mesmo mesmos meu meus minha minhas muita muitas muito muitos nada nas nem nenhum nessa nesse nesta neste
ninguém nos nossa nossas nosso nossos num numa não nós oi olá onde ora outra outras outro outros para pela pelas
pelo pelos pode podem poder por porque porém pois pra qual quais qualquer quando quanto quantos que quem sabe
se seja sejam sem sempre ser seu seus sim sobre sua suas são também tanto tão tem temos tenho ter teu teus tinha
toda todas todo todos tu tua tuas tudo têm uma umas uns vai vamos vem você vocês vos à às é
`;

const EN = `
about above after again against all also although among and another any anyone anything are around because been
before being below between both but can cannot could did does doing done down during each either else even ever
every few for from further get gets got had has have having hello her here hers herself him himself his how however
into its itself just let like made make many may maybe might more most much must myself need nor not now off once
one only other our ours ourselves out over own please same shall she should since some something still such than
thank thanks that the their theirs them themselves then there these they thing this those though through too under
until upon very was way well were what whatever when where whether which while who whom whose why will with within
without would yes yet you your yours yourself yourselves
`;

export const STOPWORDS: ReadonlySet<string> = new Set(`${PT} ${EN}`.split(/\s+/).filter(Boolean));

/**
 * The distinct words of 3+ letters or digits in `text`, lowercased, without stopwords, at most `max`. Chinese,
 * Japanese and Korean come as their character pairs (`splitWord`), as the index has them, after the other words.
 */
export function contentWords(text: string, max = 30): string[] {
  const words: string[] = [];
  const pairs: string[] = [];
  for (const [word] of text.toLowerCase().matchAll(WORD)) {
    for (const { cjk, parts } of splitWord(word)) {
      for (const w of parts) {
        if (cjk) pairs.push(w);
        else if (w.length >= 3 && !STOPWORDS.has(w)) words.push(w);
      }
    }
  }
  // Pairs come after: a long Chinese message's many pairs never push its names and numbers past `max`.
  return [...new Set([...words, ...pairs])].slice(0, max);
}
