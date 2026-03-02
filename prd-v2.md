# Requirements specification

Goal: Stores global bookmarks information across a user's bookmarking systems.

Assumes: `sync-tabgroups` has been run and the cached safari and raindrop data is available.

## The Use Case
A user's research follows a lifecycle, which roughly looks like:

1. Do some searching, find websites
2. Organize those websites into a "session", and persist that session using Tab Groups
3. Archive those websites into a Bookmarks store, which you may require later.
4. As the user performs other research, they may stumble across links that they want to save in their Session store or Bookmarks store.

Our Researcher user utilizes Safari for their session, and Raindrop.io for their bookmarks store.

The problem our user faces is that when they are in Phase 4, they do not know how where to put that bookmark:
- "Does this go in Safari or Raindrop?  I don't remember"
- "Which collection should this go in? I don't remember"

For this reason, we want to provide the user with the ability to ask these questions for any given URL.

To facilitate this, we will:
- Classify all of a user's existing Tab Groups and Bookmark Collections, and keep this up-to-date;
- Use this classification to answer the user questions above;
- Prioritize recency of Tab Group or Bookmarks Collection, if there is more than one candidate

## The Implementation

We will:
- Maintain an index of Tab Groups and Collections, which can be updated for either or both of Safari and Raindrop
- Provide the ability to classify a given Tab Group or Collection, and store that classification in our index to reduce overhead
- Provide the ability to, given an URL, associate that with a ranked list of Tab Groups+Collections (or just tab groups, or just collections)
- Provide the ability to view the data

### Tool surface

- Provide an admin tool for:
  - updating the index from the cache, to include new entries and remove stale entries
  - classifying a new entry
  - re-classifying existing entries
- Provide a user tool for:
  - reading the index entries
  - Determining which entires match a given new URL or text string

### Important Constraints
- LLMs and API calls are expensive, and we should provide the user with very granular abilities (like operate on a single item instead of batch)


## Non-goals

Dont re-implement what we already have:
1. We can create a local cached representation of Tab Groups and Collections for our use using sync-tabgroups
2. Classify a given Tab Group using an LLM using describe-tabgroup
3. Retrieve a JSON of safari and raindrop bookmarks, though we may need to update these to provide recency information.


