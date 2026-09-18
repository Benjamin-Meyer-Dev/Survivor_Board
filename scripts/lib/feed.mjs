/**
 * The odds feed, wound back to the open week's first kickoff.
 *
 * The checks under scripts/ are written against a board with a week open on
 * it: a week whose fixtures are all still ahead, with a call for every slot and
 * a list of teams behind each call. That is what the board looks like for most
 * of the week, and it is the board the coach is for.
 *
 * It is not what the committed feed holds. A week is played out over three days
 * and the finals land in the feed as they come: by Monday night an NFL week can
 * be down to one game, and between the last whistle and the next morning's pull
 * it holds none at all - the week on the clock is over, and the next one has
 * not been pulled yet. A check that reads "the open week" off the feed as it
 * stands therefore describes a different board on a Thursday and on a Tuesday,
 * and on the Tuesday no board at all. It fails on the calendar rather than on
 * the code, which is the one thing a regression check must not do.
 *
 * So the finals for the open week are dropped and the rest of the feed is left
 * exactly as it shipped: the same lines, the same kickoffs, the weeks behind it
 * settled and the weeks ahead of it open. Every check that wants a week with
 * games played in it says so itself, by writing the finals it needs.
 */

/**
 * @param {{currentWeek:number, results?:Record<string,string>}} feed A league's
 *   data/<league>/odds.json, as read.
 * @returns {typeof feed} The same feed with the open week's finals dropped.
 */
export function atKickoff(feed) {
  return {
    ...feed,
    results: Object.fromEntries(
      Object.entries(feed.results ?? {}).filter(([key]) => !key.startsWith(`${feed.currentWeek}|`)),
    ),
  };
}
