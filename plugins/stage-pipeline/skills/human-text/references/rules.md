# Rules for text people read

Rules 1–10 are about structure, rule 11 is about words, "Don't overdo it" limits them all. The process that applies them is in `${CLAUDE_PLUGIN_ROOT}/skills/human-text/SKILL.md`; the closed questions that check a draft against them are in `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md`.

The percentages are the share of stories with the feature: AI (average over five models) against humans. Source: table 16 and §4–5 of the StoryScope paper (arXiv 2604.03136), v6.

## Structure

**1. Don't state the conclusion.** AI explains the topic and the moral in 77% of stories, humans in 52%. In a work text that is "Thus…", "This matters because…" after an obvious fact, a final paragraph about the significance of what was done. State the fact once and let the reader draw the conclusion.

- ✗ "We moved payments to a queue. This significantly improved the reliability of the system and the user experience."
- ✓ "Payments go through the `payments-queue` queue: 0 lost payments in September, 14 in August."

**2. Name, don't hint.** Humans name concrete sources twice as often (47% against 24%); AI gets by with vague references in 72% of stories. Services, paths, tickets, versions, numbers, dates, commands. No number — write "not measured", not "significantly".

- ✗ "We updated several key dependencies."
- ✓ "We updated `next` 14 → 15 and `prisma` 5 → 6."

**3. Don't make the story cleaner than it is.** "No side threads" holds for 79% of AI stories and 57% of human ones; Gemini has the tidiest endings. In a work text the side threads are what is not done, known bugs, what was postponed, open questions. Everything from the card goes into the text and stays in plain view, not in a footnote.

**4. Not everything was decided by "we".** In AI stories the ending is driven by the protagonist's choice in 69%, in human ones in 46%. If the decision was forced — by a deadline, a requirement, a library limit, an incident — say so.

- ✗ "The team decided to move to Postgres."
- ✓ "We moved to Postgres: Atlas doubled its price on November 1."

**5. A decision has a price.** Humans make the protagonist's choice morally ambiguous in 59% of stories, AI in 38%. For every notable decision, say what was given up in exchange. A decision without downsides reads like an advertisement.

**6. Don't smooth the problem over.** Claude's signature in the study is the flattest rise of tension of the six sources and quiet endings. You are the one running this skill, so the habit is yours. Name the severity directly: "blocker", "two weeks late", "broken for 3% of users". A serious problem goes on the first screen, not at the end.

- ✗ "There are some difficulties with the integration."
- ✓ "The integration with 1C has been broken since September 12; the release cannot ship without it."

**7. State in words, not in images.** AI conveys a feeling through the body in 81% of stories (humans 38%) and names it directly in 8% (humans 29%). In a work text that is a metaphor instead of a fact: "foundation", "heart of the system", "journey", "growth engine", "imagine". Write what exactly: "slow — 4 s per request", "we don't know", "broken".

**8. Start with the point — not with scenery and not with chronology.** AI first sets the scene, then tells the story in order from the first clue to the resolution. The first sentence is what this is, what the status is or what is needed. No "In today's world…" and no "First we…, then…". Backstory only if it explains the decision.

The human technique of withholding the reveal is deliberately not taken here: in a work text the reader must not wait for the resolution.

**9. Write to the reader, not into the void.** Humans address the reader in 28% of stories, AI in 7%; the authors put it this way: AI writes as if nobody is reading. The text knows who it is for and what they should do: "We need your decision on X by Friday", "If you are on support — see the section on errors".

**10. No epilogue.** Claude likes epilogues in the study. Don't end with a "Summary" paragraph that retells what was written. The last line is a request, a next step with a date, or an open question.

## Words

**11. Word markers.** StoryScope sets words outside the main detector, but classifiers on raw text catch AI at 99.7–99.9% — this is the strongest signal and the cheapest to fix. Remove the markers below. Use the list for the language of the text; for another language, apply the same kinds of markers by analogy.

### English markers

- "it's worth noting", "it's important to note", "let's dive in", "let's unpack", "delve", "in the realm of", "in today's fast-paced world", "in today's world";
- "serves as" / "functions as" / "leverages" where "is" or "uses" is enough; chains "enables…, which enables…";
- evaluations without a number: "key", "significantly", "effective", "comprehensive", "seamless", "robust", "unique". The marker is the evaluation with no number behind it, not the literal word: "API key", "unique index", "effective date" stay;
- "not just X, but Y", "it's not about X — it's about Y", "What does this mean? It means…";
- triples for rhythm: "fast, convenient and reliable";
- a dash for a dramatic pause;
- "In summary", "In conclusion", "Overall," as a closing line;
- bold on every second sentence, emoji in headings, a heading over a block of three lines or fewer.

### Russian markers

<!-- ru-list:start -->
- «важно отметить», «стоит отметить», «давайте разберёмся», «погрузимся», «в рамках», «на сегодняшний день», «в современном мире»;
- «является» там, где хватает «это»; цепочки «позволяет…, что позволяет…»;
- оценки без числа: «ключевой», «значительно», «эффективный», «комплексный», «бесшовный», «надёжный», «уникальный»;
- «не просто X, а Y», «это не про X — это про Y», «Что это значит? А то, что…»;
- тройки ради ритма: «быстро, удобно и надёжно»;
- тире ради драматической паузы (грамматическое русское тире — норма);
- жирный на каждой второй фразе, эмодзи в заголовках, заголовки над тремя строками.
<!-- ru-list:end -->

## Don't overdo it

The rules are "don't do this by default", not "always do this".

- Don't insert digressions and don't break the order for the sake of "humanity" — popular retellings of the paper advise that, and it harms a work text.
- Don't invent names, numbers, problems or open questions to satisfy a rule. If it is not on the card, it is not in the text.
- A new habit in place of the old one is the same habit. By StoryScope, AI texts sit in one tight region while human ones are scattered; variety is not made by a template.
