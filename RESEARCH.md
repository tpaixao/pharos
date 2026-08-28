# P2P Preprint Archive: Research Notes

## The Problem: Preprint Server Fragility

### arXiv

**Institutional fragility:**
- Operated by Cornell University since 2001; as of July 1, 2026, transitioning to an independent nonprofit (35-year history)
- Transition driven by financial pressure: operating deficits in the past 2 years, including a $297,000 deficit in 2025
- Cornell covered the 2025 overrun and provided $819,000 in in-kind support
- Total annual operating costs scaling with submission volume; ~284,000 submissions in 2025, on track for 300,000+ in 2026
- Growth is super-exponential: monthly submissions hit nearly 28,000 by late 2025, up from linear growth pre-2023
- AI paper flood is a primary driver: cs.CL, cs.CV, cs.LG, cs.AI categories saw +37% YoY growth in 2024, +23% in 2025
- arXiv is banning computer-science survey/review papers (2025) to combat surge of low-quality AI-generated content
- Funding model: Cornell subsidy (37% of operating expenses), Simons Foundation, member institutions, individual donors, grants (NASA, Schmidt Sciences, NSF). $10M from Simons+NSF in 2023, $7M from NASA+Schmidt in 2025
- Despite grants, running at a deficit. The nonprofit transition is an attempt to achieve financial sustainability, not a sign it has been achieved

**Censorship and editorial control:**
- arXiv removed or refused papers in the superconductor controversy (2022), citing "inflammatory content"
- Banned UCSD physicist Jorge Hirsch from posting for 6 months
- Accused of censorship for editorial decisions; arXiv argues moderation is necessary for quality
- Authors cannot remove their own papers once posted: arXiv considers papers "legally deposited" and refuses removal absent copyright infringement evidence
- This is a feature for the scientific record (immutability), but means the platform controls the record, not the authors
- The banning of CS review papers (2025) is an editorial policy decision that shapes what science is visible

**Infrastructure overload:**
- 3+ million papers archived; monthly volume hitting 28,000
- The growth trajectory is described as a "vertical wall" and a "warning signal" about infrastructure sustainability
- arXiv's API has rate limits; bulk access increasingly restricted as volume grows
- The server is a single logical endpoint: if arxiv.org goes down, every link, every citation, every DOI redirect fails simultaneously

### bioRxiv

**Infrastructure dependency:**
- Hosted behind Cloudflare, which has had multiple major outages: Nov 18 2025, Dec 5 2025, Mar 21 2025, Sep 12 2025 (API/dashboard)
- bioRxiv itself has had transient failures: 503/timeout errors, HTTP 200 with empty body (Content-Length: 0), documented in our own bioRxiv digest pipeline
- These are not theoretical: we have operational experience with bioRxiv API failures on the Pi
- Single-architecture: all bioRxiv content is served from one infrastructure stack; no peer replication

**Content policies:**
- Authors can withdraw papers but they remain visible and still appear in similarity checks (cannot be truly removed)
- DMCA takedown requests can lead to removal, creating a legal lever for censorship
- The COVID-19/HIV study (2020) was formally withdrawn by authors but remains accessible on bioRxiv; withdrawal is a flag, not deletion
- bioRxiv moderation is opaque: papers can be refused without detailed explanation

### Government data removals (context, not preprint-specific)

- January 2025 onward: 8,000+ web pages and ~3,000 datasets removed from US federal agencies
- CDC: 3,000+ pages altered or removed, including research papers on chronic conditions, STIs, Alzheimer's, drug overdose prevention, adolescent health, reproductive care
- Census Bureau: ~3,000 pages removed (research and methodology)
- NASA: DEI content purged, including historical materials
- NOAA: webpages replaced with "THIS FILE IS DELETED BY EXECUTIVE ORDER"
- January 2026 study: 46% of CDC datasets that had been updated monthly showed unexplained pauses
- The Data Rescue Project (librarians, researchers) is actively working to preserve federal data through web archiving and mirroring
- This is government data, not preprints, but demonstrates the vulnerability pattern: centralized repositories can be politically purged

### Existing distributed preservation efforts

**LOCKSS (Lots of Copies Keep Stuff Safe):**
- Stanford Libraries, open-source, peer-to-peer digital preservation
- Each participating library runs a LOCKSS peer and maintains its own copy
- Distributed: no single participant controls all copies
- Used primarily for published journals (CLOCKSS = dark archive for scholarly record)
- Limitation: designed for institutional libraries with subscriptions; not open-access, not for preprints, not for individual researchers
- LOCKSS is the closest existing system to what we are proposing, but it is library-centric, not researcher-centric, and not built on modern P2P protocols

**Data Rescue Project:**
- Community of data librarians preserving US federal data
- Approach: web archiving, manual mirroring, institutional backups
- Limitation: centralized coordination, manual effort, no protocol for ongoing replication
- Demonstrates demand: volunteers are actively rescuing data because the official infrastructure is unreliable

## Threat Model Summary

| Threat | arXiv | bioRxiv | P2P archive |
|---|---|---|---|
| Server outage | Single point of failure | Single point + Cloudflare dependency | No single point; peers replicate |
| Financial collapse | Running at deficit; nonprofit transition | CHS-managed; dependent on Cold Spring Harbor funding | No operating budget needed; peers self-fund storage |
| Political pressure | Cornell is a US institution subject to US law | CHS is a US institution subject to US law | Jurisdictionally distributed; no single legal target |
| Editorial censorship | Demonstrated (superconductor papers, CS review ban, Hirsch ban) | Opaque moderation; DMCA lever | Content is append-only; no central moderator can remove; corrections are new appends |
| Author control | Authors cannot remove own papers | Authors cannot truly remove; withdrawal is a flag | Authors sign, peers replicate; author cannot un-publish, but the record is tamper-evident |
| API rate limiting | Increasingly restricted | Recurrent failures documented | Each peer serves content it has replicated; no central API |
| Infrastructure overload | 28K/month, super-exponential growth | Growing volume | Load distributed across peers; each peer handles what it replicates |
| Legal takedown (DMCA) | Platform must comply | Platform must comply | No central platform to serve takedown to; each peer makes own legal decision |

## Why preprints specifically

1. **Legal clarity:** Preprints are typically CC-licensed or author-owned. No publisher copyright to negotiate. The archive can legally replicate preprints without licensing agreements.
2. **API access:** Both arXiv and bioRxiv have public APIs (with rate limits) that can seed the archive. The data is available; the problem is single-source fragility.
3. **Volume is tractable:** ~300K arXiv papers/year, ~100K bioRxiv papers/year. A full text + metadata archive is manageable for selective replication (not full replication of all science).
4. **Existing pipeline:** The bioRxiv digest project already fetches and processes bioRxiv content daily. arXiv has an OAI-PMH interface for incremental harvesting. The ingestion layer partially exists.
5. **Citation graph is computable:** arXiv papers cite other arXiv papers; the citation graph is natively available and could be verified content-addressedly.
6. **The threat is real, not hypothetical:** Government data removals (2025-2026) prove that scientific infrastructure under political control is vulnerable. arXiv's financial deficit proves that even well-funded centralized systems are not guaranteed sustainable.