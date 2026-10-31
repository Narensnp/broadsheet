# Broadsheet

A personal news front page that reads 58 news feeds from 47 outlets around the world, groups articles about the same event into one story, and shows you how many outlets (and countries) are covering it. It runs for free on GitHub: GitHub Actions collects the news every 30 minutes, and GitHub Pages hosts the website.

- **Top stories** ranked by how widely and how recently they're covered
- **Sections**: World & Politics, Business & Finance, Technology, Innovation & Science, Singapore & Asia
- **Compare coverage**: every outlet's headline for the same event, side by side
- **Today in 60 seconds**: the top two stories in each section, for a quick morning read
- **Rising now**: topics that suddenly appear across several outlets
- Search, saved stories, read tracking, hide sources, light and dark themes
- Installable on your phone's home screen, and works offline with the last news it loaded

Broadsheet only shows a headline, a short snippet (50 words at most), the feed's thumbnail and the outlet's name, and always links to the original article.

---

## How it works (the short version)

Think of it as a newsroom with one night-shift worker and one printing press:

1. **The collector** (`collector/`, Python) is the worker. Every 30 minutes it visits each address in `feeds.yaml`, picks up the latest headlines, throws away duplicates, and sorts them into stories.
2. **The website** (`site/`, plain HTML, CSS and JavaScript) is the printed paper. It doesn't fetch news itself; it just reads the JSON files the collector wrote and lays them out.
3. **The workflow** (`.github/workflows/update.yml`) is the alarm clock and the printing press. GitHub runs it on a timer: it starts the collector, puts the fresh files next to the website, and publishes the result to GitHub Pages.

The news files are **never committed** to your repository (that would add thousands of pointless commits). Instead, at the start of each run the workflow downloads yesterday's paper, so to speak, from your live website, so the collector can remember the last seven days and spot what's new.

### How stories are grouped

Each article becomes a list of "how important is each word here" scores. Rare, specific words (*Miyagi*, *semiconductor*) score high; everyday words (*said*, *new*) score almost nothing. Two articles with lots of high-scoring words in common are probably about the same event. Broadsheet joins the closest pairs first, but only if everything in the group was published within 48 hours and the group as a whole still hangs together. (Technically: TF-IDF vectors and cosine similarity, with the knobs at the top of `collector/cluster.py`.)

### How top stories are ranked

Every outlet covering a story is a **vote**. A vote is worth 1 when the article is brand new and loses half its value every 10 hours. Add up the votes and you have the score. So twelve outlets in the last three hours easily beat two outlets yesterday. Stories covered from several countries get a small bonus.

### How "Rising now" works

Counting the most common words would show the same names every day. Instead, Broadsheet compares how often a phrase appears in the last 6 hours with how often you'd *expect* it to, based on the 48 hours before. A phrase that suddenly appears across at least three outlets is "rising".

---

## Project layout

```
broadsheet/
├── feeds.yaml                  ← the list of news sources (edit this one)
├── collector/
│   ├── collect.py              ← main script: run this
│   ├── fetcher.py              ← downloads feeds (15 s timeout, 1 retry)
│   ├── parse.py                ← turns feed entries into articles
│   ├── cluster.py              ← groups articles into stories, ranks them
│   ├── trending.py             ← finds rising topics
│   ├── textutil.py             ← cleaning text and links
│   ├── fetch_previous.py       ← downloads the last run's data from your site
│   └── requirements.txt        ← Python libraries (exact versions)
├── site/
│   ├── index.html
│   ├── css/styles.css          ← all colours are CSS variables at the top
│   ├── js/                     ← app.js, views.js, data.js, ui.js, store.js, config.js
│   ├── sw.js                   ← offline support
│   ├── manifest.webmanifest    ← "Add to Home Screen" settings
│   └── icons/
├── .github/workflows/update.yml
├── README.md
└── .gitignore
```

The collector writes these files into `site/data/`: `top.json`, `world.json`, `business.json`, `technology.json`, `science.json`, `asia.json`, `trending.json`, `sources.json`, `status.json`, plus `version.json` (a tiny file the website checks every 5 minutes to see if there's new news) and `archive.json` (the rolling 7-day memory, only read by the next collector run).

---

# Beginner's setup guide (Windows)

This guide assumes you've used Git inside Android Studio but never GitHub's website or GitHub Desktop. Nothing here costs money.

## 1. Install GitHub Desktop and sign in

1. Go to **https://desktop.github.com** and click **Download for Windows**. Run the installer; it installs and opens by itself.
2. If you don't have a GitHub account yet, create one at **https://github.com/signup** first. Your username becomes part of your website address, so pick one you like.
3. In GitHub Desktop, click **Sign in to GitHub.com**. Your browser opens; sign in and click **Authorize desktop**. Switch back to GitHub Desktop.
4. If it asks you to "Configure Git", keep the suggested name and email and click **Finish**.

## 2. Create a new public repository called "broadsheet"

A repository ("repo") is just a project folder that GitHub keeps a history of, exactly like the projects you've committed from Android Studio.

1. In GitHub Desktop: **File → New repository…**
2. Fill in:
   - **Name:** `broadsheet` (all lower case; this becomes part of your web address)
   - **Description:** anything, e.g. "My news front page"
   - **Local path:** leave the default (usually `C:\Users\<you>\Documents\GitHub`)
   - **Initialize this repository with a README:** leave **unticked** (the project already has one)
   - **Git ignore:** None. **License:** None.
3. Click **Create repository**.
4. Click the blue **Publish repository** button at the top.
5. **Untick "Keep this code private"**, then click **Publish repository**.

**Why public?** Free GitHub accounts can only publish a GitHub Pages website from a *public* repository. That's fine here: there's nothing secret in this project. There are no passwords, API keys or personal data; it's just code and a list of public news feed addresses. (Your saved stories and reading history live only in your phone's or computer's browser, never on GitHub.)

## 3. Put the project files in the repository and push them

1. Unzip `broadsheet.zip` somewhere, for example on your Desktop.
2. In GitHub Desktop, click **Repository → Show in Explorer**. This opens your empty `broadsheet` repository folder.
3. Open the unzipped `broadsheet` folder, select **everything inside it** (Ctrl+A) and copy it (Ctrl+C). Paste (Ctrl+V) into the repository folder.
   - Make sure the **`.github`** folder came along. It holds the workflow, and without it nothing runs automatically.
   - You should end up with `feeds.yaml`, `README.md`, `.gitignore`, and the folders `.github`, `collector` and `site` directly inside the repository folder (not inside an extra `broadsheet` folder).
4. Go back to GitHub Desktop. The left panel now lists all the new files.
5. At the bottom left, type a summary such as `Add Broadsheet` and click **Commit to main**.
6. Click **Push origin** at the top.

Pushing automatically starts the workflow once. **That first run will fail (a red cross) because GitHub Pages isn't switched on yet. That's expected**, and step 4 fixes it.

## 4. Turn on GitHub Pages

1. In GitHub Desktop, click **Repository → View on GitHub** (or go to `https://github.com/<your-username>/broadsheet`).
2. Click **Settings** (the gear tab at the top of the repository page; not your account settings).
3. In the left sidebar, under "Code and automation", click **Pages**.
4. Under **Build and deployment → Source**, choose **GitHub Actions**.

There's nothing to save; the choice applies immediately.

## 5. Run the workflow for the first time

1. On your repository page, click the **Actions** tab.
2. In the left list, click **Update Broadsheet**.
3. On the right, click the **Run workflow** dropdown, leave the branch as `main`, and click the green **Run workflow** button.
4. After a few seconds a new run appears (refresh the page if it doesn't). It takes about 2 to 4 minutes.

What the symbols mean:

- **Yellow circle**: still running.
- **Green tick**: it worked; the website has been published with fresh news.
- **Red cross**: something went wrong; nothing was published, and your site (if it already existed) keeps showing the previous news.

**Reading an error:** click the failed run, then click the job with the red cross (for example "Collect news and build the site"). The steps are listed; the failed one is expanded with a red icon. Scroll to the bottom of that step: the last few lines say what went wrong. Common ones:

- *"Get Pages site failed"* or *"Ensure GitHub Pages has been enabled"*: step 4 hasn't been done (or the Source isn't set to "GitHub Actions"). Fix it, then click **Re-run all jobs** at the top right of the run.
- *"every feed failed"*: GitHub's network had a hiccup or all sites blocked the request. Wait and run it again.
- A Python error with `feeds.yaml` in it: there's a typo in `feeds.yaml` (usually wrong indentation). See step 7.

## 6. Open the website on your phone and add it to your home screen

1. Your address is **`https://<your-username>.github.io/broadsheet/`**. You can also find it in **Settings → Pages** ("Your site is live at …") or in the successful run under the "deploy" job.
2. On your Samsung phone, open that address in **Chrome**.
3. Tap the **⋮** menu → **Add to home screen** → **Install**. (In **Samsung Internet**: tap the **≡** menu → **Add page to** → **Home screen**.)
4. Broadsheet now opens from its own icon, full screen, like an app. It keeps the last news it loaded, so it opens instantly and still works on a plane.

While the app is open it checks for new news every 5 minutes. If there is some, a **New stories** button appears at the top instead of the page jumping around; tap it to load them.

## 7. Add or remove news sources (on github.com)

1. On your repository page, click **`feeds.yaml`**.
2. Click the **pencil icon** ("Edit this file") at the top right of the file.
3. **To add a source**, copy an existing block and change the values. Keep the indentation exactly the same: two spaces before `- name:`, four spaces before the other fields.

   ```yaml
     - name: The Atlantic
       url: https://www.theatlantic.com/feed/all/
       homepage: https://www.theatlantic.com
       category: world
       region: Americas
       country: United States
   ```

   `category` must be one of `world`, `business`, `technology`, `science`, `asia`.
   To find a site's feed, look for an orange RSS icon, or try adding `/feed`, `/rss` or `/rss.xml` to its address.

4. **To remove a source**, delete its block (all six lines), or switch it off by putting `# ` at the start of each of its lines.
5. Click **Commit changes…**, leave **Commit directly to the main branch** selected, and click **Commit changes**.

Committing starts the workflow automatically, so the site updates in a few minutes. Check the **Actions** tab for the green tick, then open the **Feed status** page (link in the site's footer) to see whether the new feed works.

**Important:** after editing on github.com, open GitHub Desktop and click **Fetch origin**, then **Pull origin**, before you change anything on your computer. Otherwise your computer's copy is out of date and the next push gets complicated.

## 8. Test on your own computer before pushing

You only need this if you want to try changes locally first.

**Install Python (once):**

1. Download **Python 3.12** for Windows from **https://www.python.org/downloads/windows/** (the "Windows installer (64-bit)").
2. On the first installer screen, **tick "Add python.exe to PATH"**, then click **Install Now**.

**Open a command prompt in the project folder:** in GitHub Desktop, click **Repository → Open in Command Prompt**. (If it offers a different terminal, that's fine too, but the commands below are for Command Prompt.)

**Set up once** (creates a private Python environment in a `.venv` folder, which Git ignores):

```bat
py -3.12 -m venv .venv
.venv\Scripts\activate
python -m pip install -r collector\requirements.txt
```

**Every time you want to test:**

```bat
.venv\Scripts\activate
python collector\collect.py
cd site
python -m http.server 8000
```

- `collect.py` fetches all the feeds (takes about a minute) and writes the JSON into `site\data`. That folder is listed in `.gitignore`, so it never gets committed.
- `http.server` starts a small web server. Open **http://localhost:8000** in your browser to see the site.
- Press **Ctrl+C** in the command prompt to stop the server, and type `cd ..` to go back to the project folder.
- If you change CSS or JavaScript and don't see the change, press **Ctrl+Shift+R** in the browser (the offline cache may be showing the old version).

When you're happy, commit and push in GitHub Desktop as in step 3.

## 9. Common gotchas

**"Every 30 minutes" is approximate.** GitHub runs scheduled workflows on a best-effort basis. When its servers are busy (often at the top of the hour), runs can start late by 10 to 30 minutes, and occasionally one is skipped. This is normal. You can always press **Run workflow** to update immediately.

**Scheduled runs stop after 60 days without activity.** In public repositories, GitHub pauses scheduled workflows if nothing has been committed to the repository for 60 days. The site stays online but stops updating. To turn it back on: open the **Actions** tab, click **Update Broadsheet** in the left list, and click **Enable workflow** in the yellow banner. Any commit (for example a small edit to `feeds.yaml` or this README) also counts as activity and resets the 60-day clock.

**A feed shows as "Failed" or "Empty" on the Status page.** One or two failures are normal; the rest of the site carries on without them. Look at the **Details** column:

- *HTTP 404* or *the feed address no longer exists*: the outlet moved or removed its feed. Find the new address on its website and update `feeds.yaml`, or remove the source.
- *HTTP 403* or *refused access*: the outlet blocks automated readers coming from GitHub's servers. There's no fix; remove the source or leave it switched off.
- *Timed out* or *server error*: usually temporary. If it says "Not OK for many runs in a row", treat it like a 404.
- *Not a readable RSS/Atom feed*: the address points to a normal web page, not a feed.

**The site looks a few minutes behind the Actions tab.** GitHub Pages caches files for up to 10 minutes. The app also asks for fresh data every 5 minutes while open.

**You edited files on github.com and on your computer.** Pull first (step 7). If GitHub Desktop reports a conflict, the simplest fix for a beginner is to copy your local changes somewhere safe, discard them in GitHub Desktop (right-click the file → Discard changes), pull, then re-apply your changes.

**Cost.** GitHub Actions minutes are free and unlimited for public repositories, and GitHub Pages is free.

---

## Customising

- **Colours:** the top of `site/css/styles.css`. Each section has an accent (`--c-world`, `--c-business`, …) and each world region has a colour for the coverage bar (`--r-europe`, …). Dark theme colours are in the blocks just below.
- **How strict story grouping is:** `PAIR_THRESHOLD` and `GROUP_THRESHOLD` at the top of `collector/cluster.py`. Higher numbers make smaller, stricter groups; lower numbers merge more aggressively.
- **How fast stories fade:** `HALF_LIFE_HOURS` in `collector/cluster.py`.
- **Rising topics:** `MIN_SOURCES`, `MIN_LIFT` and the time windows at the top of `collector/trending.py`.
- **Schedule:** the `cron` line in `.github/workflows/update.yml` (times are UTC).

## Content and attribution

Broadsheet uses only feeds that publishers offer publicly, never visits article pages, and identifies itself with a `Broadsheet/1.0` user agent that includes your repository address. It shows a headline, a snippet of at most about 50 words, the thumbnail the feed provides and the outlet's name, and every link opens the original article. It doesn't rate outlets for political bias; the story view lets you compare how each outlet frames the same event.

Reuters and the Associated Press no longer publish public RSS feeds, and Nikkei Asia doesn't offer one, so they aren't included directly; many of the included outlets carry their wire stories.
