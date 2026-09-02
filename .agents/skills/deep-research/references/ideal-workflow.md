# Plan construction

The capability catalog is the map of every exposed lane. There is no path to climb.

1. Open `capability-catalog.md`. Every row is eligible.
2. List rows that could answer the angles. Pick a mix. Show Chosen vs Rejected vs Cost (guidance, not a quote).
3. Name ceilings from the chosen rows (`limit`, `max_credits`, processor, `x_api` `max_results`).
4. Numbered **How to proceed** in the **visible** message. Do not call `ask`. Stop and wait.

Cost numbers in the catalog are guidance for the Cost section, not a required order of tools.

Parallel `task` cannot be cancelled. Firecrawl `POST /crawl` and agent starts are not retried. Do not start those in the plan turn.

## After the hunt

One-line score: win / mixed / fail · best capability · worst · one lesson.
