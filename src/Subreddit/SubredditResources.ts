import Snoowrap, {RedditUser} from "snoowrap";
import objectHash from 'object-hash';
import {
    activityIsDeleted, activityIsFiltered,
    activityIsRemoved,
    AuthorActivitiesOptions,
    AuthorTypedActivitiesOptions, BOT_LINK,
    getAuthorActivities,
    testAuthorCriteria
} from "../Utils/SnoowrapUtils";
import Subreddit from 'snoowrap/dist/objects/Subreddit';
import winston, {Logger} from "winston";
import fetch from 'node-fetch';
import {
    asSubmission,
    buildCacheOptionsFromProvider, buildCachePrefix,
    cacheStats, createCacheManager,
    formatNumber, getActivityAuthorName,
    mergeArr,
    parseExternalUrl,
    parseWikiContext
} from "../util";
import LoggedError from "../Utils/LoggedError";
import {
    BotInstanceConfig,
    CacheOptions, CommentState,
    Footer, OperatorConfig, ResourceStats, StrongCache, SubmissionState,
    CacheConfig, TTLConfig, TypedActivityStates, UserResultCache
} from "../Common/interfaces";
import UserNotes from "./UserNotes";
import Mustache from "mustache";
import he from "he";
import {AuthorCriteria} from "../Author/Author";
import {SPoll} from "./Streams";
import {Cache} from 'cache-manager';
import {Submission, Comment} from "snoowrap/dist/objects";
import {cacheTTLDefaults} from "../Common/defaults";
import {check} from "tcp-port-used";

export const DEFAULT_FOOTER = '\r\n*****\r\nThis action was performed by [a bot.]({{botLink}}) Mention a moderator or [send a modmail]({{modmailLink}}) if you any ideas, questions, or concerns about this action.';

export interface SubredditResourceConfig extends Footer {
    caching?: CacheConfig,
    subreddit: Subreddit,
    logger: Logger;
    client: Snoowrap
}

interface SubredditResourceOptions extends Footer {
    ttl: Required<TTLConfig>
    cache: Cache
    cacheType: string;
    cacheSettingsHash: string
    subreddit: Subreddit,
    logger: Logger;
    client: Snoowrap;
    prefix? :string;
}

export interface SubredditResourceSetOptions extends CacheConfig, Footer {
}

export class SubredditResources {
    //enabled!: boolean;
    protected useSubredditAuthorCache!: boolean;
    protected authorTTL: number | false = cacheTTLDefaults.authorTTL;
    protected wikiTTL: number | false = cacheTTLDefaults.wikiTTL;
    protected submissionTTL: number | false = cacheTTLDefaults.submissionTTL;
    protected commentTTL: number | false = cacheTTLDefaults.commentTTL;
    protected filterCriteriaTTL: number | false = cacheTTLDefaults.filterCriteriaTTL;
    name: string;
    protected logger: Logger;
    userNotes: UserNotes;
    footer: false | string = DEFAULT_FOOTER;
    subreddit: Subreddit
    client: Snoowrap
    cache: Cache
    cacheType: string
    cacheSettingsHash?: string;
    pruneInterval?: any;
    prefix?: string

    stats: { cache: ResourceStats };

    constructor(name: string, options: SubredditResourceOptions) {
        const {
            subreddit,
            logger,
            ttl: {
                userNotesTTL,
                authorTTL,
                wikiTTL,
                filterCriteriaTTL,
                submissionTTL,
                commentTTL,
            },
            cache,
            prefix,
            cacheType,
            cacheSettingsHash,
            client,
        } = options || {};

        this.cacheSettingsHash = cacheSettingsHash;
        this.cache = cache;
        this.prefix = prefix;
        this.client = client;
        this.cacheType = cacheType;
        this.authorTTL = authorTTL === true ? 0 : authorTTL;
        this.submissionTTL = submissionTTL === true ? 0 : submissionTTL;
        this.commentTTL = commentTTL === true ? 0 : commentTTL;
        this.wikiTTL = wikiTTL === true ? 0 : wikiTTL;
        this.filterCriteriaTTL = filterCriteriaTTL === true ? 0 : filterCriteriaTTL;
        this.subreddit = subreddit;
        this.name = name;
        if (logger === undefined) {
            const alogger = winston.loggers.get('app')
            this.logger = alogger.child({labels: [this.name, 'Resource Cache']}, mergeArr);
        } else {
            this.logger = logger.child({labels: ['Resource Cache']}, mergeArr);
        }

        this.stats = {
            cache: cacheStats()
        };

        const cacheUseCB = (miss: boolean) => {
            this.stats.cache.userNotes.requestTimestamps.push(Date.now());
            this.stats.cache.userNotes.requests++;
            this.stats.cache.userNotes.miss += miss ? 1 : 0;
        }
        this.userNotes = new UserNotes(userNotesTTL, this.subreddit, this.logger, this.cache, cacheUseCB)

        if(this.cacheType === 'memory' && this.cacheSettingsHash !== 'default') {
            const min = Math.min(...([this.wikiTTL, this.authorTTL, this.submissionTTL, this.commentTTL, this.filterCriteriaTTL].filter(x => typeof x === 'number' && x !== 0) as number[]));
            if(min > 0) {
                // set default prune interval
                this.pruneInterval = setInterval(() => {
                    // @ts-ignore
                    this.defaultCache?.store.prune();
                    this.logger.debug('Pruned cache');
                    // prune interval should be twice the smallest TTL
                },min * 1000 * 2)
            }
        }
    }

    async getCacheKeyCount() {
        if (this.cache.store.keys !== undefined) {
            if(this.cacheType === 'redis') {
                return (await this.cache.store.keys(`${this.prefix}*`)).length;
            }
            return (await this.cache.store.keys()).length;
        }
        return 0;
    }

    async getStats() {
        const totals = Object.values(this.stats.cache).reduce((acc, curr) => ({
            miss: acc.miss + curr.miss,
            req: acc.req + curr.requests,
        }), {miss: 0, req: 0});
        const cacheKeys = Object.keys(this.stats.cache);
        return {
            cache: {
                // TODO could probably combine these two
                totalRequests: totals.req,
                totalMiss: totals.miss,
                missPercent: `${formatNumber(totals.miss === 0 || totals.req === 0 ? 0 :(totals.miss/totals.req) * 100, {toFixed: 0})}%`,
                types: await cacheKeys.reduce(async (accProm, curr) => {
                    const acc = await accProm;
                    // calculate miss percent

                    const per = acc[curr].miss === 0 ? 0 : formatNumber(acc[curr].miss / acc[curr].requests) * 100;
                    acc[curr].missPercent = `${formatNumber(per, {toFixed: 0})}%`;

                    // calculate average identifier hits

                    const idCache = acc[curr].identifierRequestCount;
                    // @ts-expect-error
                    const idKeys = await idCache.store.keys() as string[];
                    if(idKeys.length > 0) {
                        let hits = 0;
                        for (const k of idKeys) {
                            hits += await idCache.get(k) as number;
                        }
                        acc[curr].identifierAverageHit = formatNumber(hits/idKeys.length);
                    }

                    if(acc[curr].requestTimestamps.length > 1) {
                        // calculate average time between request
                        const diffData = acc[curr].requestTimestamps.reduce((acc, curr: number) => {
                            if(acc.last === 0) {
                                acc.last = curr;
                                return acc;
                            }
                            acc.diffs.push(curr - acc.last);
                            acc.last = curr;
                            return acc;
                        },{last: 0, diffs: [] as number[]});
                        const avgDiff = diffData.diffs.reduce((acc, curr) => acc + curr, 0) / diffData.diffs.length;

                        acc[curr].averageTimeBetweenHits = formatNumber(avgDiff/1000);
                    }

                    return acc;
                }, Promise.resolve(this.stats.cache))
            }
        }
    }

    setLogger(logger: Logger) {
        this.logger = logger.child({labels: ['Resource Cache']}, mergeArr);
    }

    async getActivity(item: Submission | Comment) {
        try {
            let hash = '';
            if (this.submissionTTL !== false && asSubmission(item)) {
                hash = `sub-${item.name}`;
                await this.stats.cache.submission.identifierRequestCount.set(hash, (await this.stats.cache.submission.identifierRequestCount.wrap(hash, () => 0) as number) + 1);
                this.stats.cache.submission.requestTimestamps.push(Date.now());
                this.stats.cache.submission.requests++;
                const cachedSubmission = await this.cache.get(hash);
                if (cachedSubmission !== undefined && cachedSubmission !== null) {
                    this.logger.debug(`Cache Hit: Submission ${item.name}`);
                    return cachedSubmission;
                }
                // @ts-ignore
                const submission = await item.fetch();
                this.stats.cache.submission.miss++;
                await this.cache.set(hash, submission, {ttl: this.submissionTTL});
                return submission;
            } else if (this.commentTTL !== false) {
                hash = `comm-${item.name}`;
                await this.stats.cache.comment.identifierRequestCount.set(hash, (await this.stats.cache.comment.identifierRequestCount.wrap(hash, () => 0) as number) + 1);
                this.stats.cache.comment.requestTimestamps.push(Date.now());
                this.stats.cache.comment.requests++;
                const cachedComment = await this.cache.get(hash);
                if (cachedComment !== undefined && cachedComment !== null) {
                    this.logger.debug(`Cache Hit: Comment ${item.name}`);
                    return cachedComment;
                }
                // @ts-ignore
                const comment = await item.fetch();
                this.stats.cache.comment.miss++;
                await this.cache.set(hash, comment, {ttl: this.commentTTL});
                return comment;
            } else {
                // @ts-ignore
                return await item.fetch();
            }
        } catch (err) {
            this.logger.error('Error while trying to fetch a cached activity', err);
            throw err.logged;
        }
    }

    async getAuthorActivities(user: RedditUser, options: AuthorTypedActivitiesOptions): Promise<Array<Submission | Comment>> {
        const userName = getActivityAuthorName(user);
        if (this.authorTTL !== false) {
            const hashObj: any = options;
            if (this.useSubredditAuthorCache) {
                hashObj.subreddit = this.subreddit;
            }
            const hash = `authorActivities-${userName}-${options.type || 'overview'}-${objectHash.sha1(hashObj)}`;

            this.stats.cache.author.requests++;
            await this.stats.cache.author.identifierRequestCount.set(userName, (await this.stats.cache.author.identifierRequestCount.wrap(userName, () => 0) as number) + 1);
            this.stats.cache.author.requestTimestamps.push(Date.now());
            let miss = false;
            const cacheVal = await this.cache.wrap(hash, async () => {
                miss = true;
                if(typeof user === 'string') {
                    // @ts-ignore
                    user = await this.client.getUser(userName);
                }
                return await getAuthorActivities(user, options);
            }, {ttl: this.authorTTL});
            if (!miss) {
                this.logger.debug(`Cache Hit: ${userName} (Hash ${hash})`);
            } else {
                this.stats.cache.author.miss++;
            }
            return cacheVal as Array<Submission | Comment>;
        }
        if(typeof user === 'string') {
            // @ts-ignore
            user = await this.client.getUser(userName);
        }
        return await getAuthorActivities(user, options);
    }

    async getAuthorComments(user: RedditUser, options: AuthorActivitiesOptions): Promise<Comment[]> {
        return await this.getAuthorActivities(user, {...options, type: 'comment'}) as unknown as Promise<Comment[]>;
    }

    async getAuthorSubmissions(user: RedditUser, options: AuthorActivitiesOptions): Promise<Submission[]> {
        return await this.getAuthorActivities(user, {
            ...options,
            type: 'submission'
        }) as unknown as Promise<Submission[]>;
    }

    async getContent(val: string, subredditArg?: Subreddit): Promise<string> {
        const subreddit = subredditArg || this.subreddit;
        let cacheKey;
        const wikiContext = parseWikiContext(val);
        if (wikiContext !== undefined) {
            cacheKey = `${wikiContext.wiki}${wikiContext.subreddit !== undefined ? `|${wikiContext.subreddit}` : ''}`;
        }
        const extUrl = wikiContext === undefined ? parseExternalUrl(val) : undefined;
        if (extUrl !== undefined) {
            cacheKey = extUrl;
        }

        if (cacheKey === undefined) {
            return val;
        }

        // try to get cached value first
        let hash = `${subreddit.display_name}-content-${cacheKey}`;
        if (this.wikiTTL !== false) {
            await this.stats.cache.content.identifierRequestCount.set(cacheKey, (await this.stats.cache.content.identifierRequestCount.wrap(cacheKey, () => 0) as number) + 1);
            this.stats.cache.content.requestTimestamps.push(Date.now());
            this.stats.cache.content.requests++;
            const cachedContent = await this.cache.get(hash);
            if (cachedContent !== undefined && cachedContent !== null) {
                this.logger.debug(`Content Cache Hit: ${cacheKey}`);
                return cachedContent as string;
            } else {
                this.stats.cache.content.miss++;
            }
        }

        let wikiContent: string;

        // no cache hit, get from source
        if (wikiContext !== undefined) {
            let sub;
            if (wikiContext.subreddit === undefined || wikiContext.subreddit.toLowerCase() === subreddit.display_name) {
                sub = subreddit;
            } else {
                sub = this.client.getSubreddit(wikiContext.subreddit);
            }
            try {
                // @ts-ignore
                const wikiPage = sub.getWikiPage(wikiContext.wiki);
                wikiContent = await wikiPage.content_md;
            } catch (err) {
                let msg = `Could not read wiki page for an unknown reason. Please ensure the page 'https://reddit.com${sub.display_name_prefixed}/wiki/${wikiContext.wiki}' exists and is readable`;
                if(err.statusCode !== undefined) {
                    if(err.statusCode === 404) {
                        msg = `Could not find a wiki page at https://reddit.com${sub.display_name_prefixed}/wiki/${wikiContext.wiki} -- Reddit returned a 404`;
                    } else if(err.statusCode === 403 || err.statusCode === 401) {
                        msg = `Bot either does not have permission visibility permissions for the wiki page at https://reddit.com${sub.display_name_prefixed}wiki/${wikiContext.wiki} (due to subreddit restrictions) or the bot does have have oauth permissions to read wiki pages (operator error). Reddit returned a ${err.statusCode}`;
                    }
                }
                this.logger.error(msg, err);
                throw new LoggedError(msg);
            }
        } else {
            try {
                const response = await fetch(extUrl as string);
                wikiContent = await response.text();
            } catch (err) {
                const msg = `Error occurred while trying to fetch the url ${extUrl}`;
                this.logger.error(msg, err);
                throw new LoggedError(msg);
            }
        }

        if (this.wikiTTL !== false) {
            this.cache.set(hash, wikiContent, {ttl: this.wikiTTL});
        }

        return wikiContent;
    }

    async testAuthorCriteria(item: (Comment | Submission), authorOpts: AuthorCriteria, include = true) {
        if (this.filterCriteriaTTL !== false) {
            // in the criteria check we only actually use the `item` to get the author flair
            // which will be the same for the entire subreddit
            //
            // so we can create a hash only using subreddit-author-criteria
            // and ignore the actual item
            const hashObj = {...authorOpts, include};
            const userName = getActivityAuthorName(item.author);
            const hash = `authorCrit-${this.subreddit.display_name}-${userName}-${objectHash.sha1(hashObj)}`;
            await this.stats.cache.authorCrit.identifierRequestCount.set(hash, (await this.stats.cache.authorCrit.identifierRequestCount.wrap(hash, () => 0) as number) + 1);
            this.stats.cache.authorCrit.requestTimestamps.push(Date.now());
            this.stats.cache.authorCrit.requests++;
            let miss = false;
            const cachedAuthorTest = await this.cache.wrap(hash, async () => {
                miss = true;
                return await testAuthorCriteria(item, authorOpts, include, this.userNotes);
            }, {ttl: this.filterCriteriaTTL});
            if (!miss) {
                this.logger.debug(`Cache Hit: Author Check on ${userName} (Hash ${hash})`);
            } else {
                this.stats.cache.authorCrit.miss++;
            }
            return cachedAuthorTest;
        }

        return await testAuthorCriteria(item, authorOpts, include, this.userNotes);
    }

    async testItemCriteria(i: (Comment | Submission), s: TypedActivityStates) {
        if (this.filterCriteriaTTL !== false) {
            let item = i;
            let states = s;
            // optimize for submission only checks on comment item
            if (item instanceof Comment && states.length === 1 && Object.keys(states[0]).length === 1 && (states[0] as CommentState).submissionState !== undefined) {
                // @ts-ignore
                const subProxy = await this.client.getSubmission(await i.link_id);
                // @ts-ignore
                item = await this.getActivity(subProxy);
                states = (states[0] as CommentState).submissionState as SubmissionState[];
            }
            try {
                const hash = `itemCrit-${item.name}-${objectHash.sha1(states)}`;
                await this.stats.cache.itemCrit.identifierRequestCount.set(hash, (await this.stats.cache.itemCrit.identifierRequestCount.wrap(hash, () => 0) as number) + 1);
                this.stats.cache.itemCrit.requestTimestamps.push(Date.now());
                this.stats.cache.itemCrit.requests++;
                const cachedItem = await this.cache.get(hash);
                if (cachedItem !== undefined && cachedItem !== null) {
                    this.logger.debug(`Cache Hit: Item Check on ${item.name} (Hash ${hash})`);
                    return cachedItem as boolean;
                }
                const itemResult = await this.isItem(item, states, this.logger);
                this.stats.cache.itemCrit.miss++;
                await this.cache.set(hash, itemResult, {ttl: this.filterCriteriaTTL});
                return itemResult;
            } catch (err) {
                if (err.logged !== true) {
                    this.logger.error('Error occurred while testing item criteria', err);
                }
                throw err;
            }
        }

        return await this.isItem(i, s, this.logger);
    }

    async isItem (item: Submission | Comment, stateCriteria: TypedActivityStates, logger: Logger) {
        if (stateCriteria.length === 0) {
            return true;
        }

        const log = logger.child({leaf: 'Item Check'}, mergeArr);

        for (const crit of stateCriteria) {
            const pass = await (async () => {
                for (const k of Object.keys(crit)) {
                    // @ts-ignore
                    if (crit[k] !== undefined) {
                        switch (k) {
                            case 'submissionState':
                                if(!(item instanceof Comment)) {
                                    log.warn('`submissionState` is not allowed in `itemIs` criteria when the main Activity is a Submission');
                                    continue;
                                }
                                // get submission
                                // @ts-ignore
                                const subProxy = await this.client.getSubmission(await item.link_id);
                                // @ts-ignore
                                const sub = await this.getActivity(subProxy);
                                // @ts-ignore
                                const res = await this.testItemCriteria(sub, crit[k] as SubmissionState[], logger);
                                if(!res) {
                                    return false;
                                }
                                break;
                            case 'removed':
                                const removed = activityIsRemoved(item);
                                if (removed !== crit['removed']) {
                                    // @ts-ignore
                                    log.debug(`Failed: Expected => ${k}:${crit[k]} | Found => ${k}:${removed}`)
                                    return false
                                }
                                break;
                            case 'deleted':
                                const deleted = activityIsDeleted(item);
                                if (deleted !== crit['deleted']) {
                                    // @ts-ignore
                                    log.debug(`Failed: Expected => ${k}:${crit[k]} | Found => ${k}:${deleted}`)
                                    return false
                                }
                                break;
                            case 'filtered':
                                const filtered = activityIsFiltered(item);
                                if (filtered !== crit['filtered']) {
                                    // @ts-ignore
                                    log.debug(`Failed: Expected => ${k}:${crit[k]} | Found => ${k}:${filtered}`)
                                    return false
                                }
                                break;
                            case 'title':
                                if((item instanceof Comment)) {
                                    log.warn('`title` is not allowed in `itemIs` criteria when the main Activity is a Comment');
                                    continue;
                                }
                                // @ts-ignore
                                const titleReg = crit[k] as string;
                                try {
                                    if(null === item.title.match(titleReg)) {
                                        // @ts-ignore
                                        log.debug(`Failed to match title as regular expression: ${titleReg}`);
                                        return false;
                                    }
                                } catch (err) {
                                    log.error(`An error occurred while attempting to match title against string as regular expression: ${titleReg}. Most likely the string does not make a valid regular expression.`, err);
                                    return false
                                }
                                break;
                            default:
                                // @ts-ignore
                                if (item[k] !== undefined) {
                                    // @ts-ignore
                                    if (item[k] !== crit[k]) {
                                        // @ts-ignore
                                        log.debug(`Failed: Expected => ${k}:${crit[k]} | Found => ${k}:${item[k]}`)
                                        return false
                                    }
                                } else {
                                    log.warn(`Tried to test for Item property '${k}' but it did not exist`);
                                }
                                break;
                        }
                    }
                }
                log.debug(`Passed: ${JSON.stringify(crit)}`);
                return true;
            })() as boolean;
            if (pass) {
                return true
            }
        }
        return false
    }

    async getCommentCheckCacheResult(item: Comment, checkConfig: object): Promise<UserResultCache | undefined> {
        const userName = getActivityAuthorName(item.author);
        const hash = `commentUserResult-${userName}-${item.link_id}-${objectHash.sha1(checkConfig)}`;
        this.stats.cache.commentCheck.requests++;
        let result = await this.cache.get(hash) as UserResultCache | undefined | null;
        if(result === null) {
            result = undefined;
        }
        if(result === undefined) {
            this.stats.cache.commentCheck.miss++;
        }
        this.logger.debug(`Cache Hit: Comment Check for ${userName} in Submission ${item.link_id} (Hash ${hash})`);
        return result;
    }

    async setCommentCheckCacheResult(item: Comment, checkConfig: object, result: UserResultCache, ttl: number) {
        const userName = getActivityAuthorName(item.author);
        const hash = `commentUserResult-${userName}-${item.link_id}-${objectHash.sha1(checkConfig)}`
        await this.cache.set(hash, result, { ttl });
        this.logger.debug(`Cached check result '${result.result}' for User ${userName} on Submission ${item.link_id} for ${ttl} seconds (Hash ${hash})`);
    }

    async generateFooter(item: Submission | Comment, actionFooter?: false | string) {
        let footer = actionFooter !== undefined ? actionFooter : this.footer;
        if (footer === false) {
            return '';
        }
        const subName = await item.subreddit.display_name;
        const permaLink = `https://reddit.com${await item.permalink}`
        const modmailLink = `https://www.reddit.com/message/compose?to=%2Fr%2F${subName}&message=${encodeURIComponent(permaLink)}`

        const footerRawContent = await this.getContent(footer, item.subreddit);
        return he.decode(Mustache.render(footerRawContent, {subName, permaLink, modmailLink, botLink: BOT_LINK}));
    }
}

export class BotResourcesManager {
    resources: Map<string, SubredditResources> = new Map();
    authorTTL: number = 10000;
    enabled: boolean = true;
    modStreams: Map<string, SPoll<Snoowrap.Submission | Snoowrap.Comment>> = new Map();
    defaultCache: Cache;
    defaultCacheConfig: StrongCache
    cacheType: string = 'none';
    cacheHash: string;
    ttlDefaults: Required<TTLConfig>;
    pruneInterval: any;

    constructor(config: BotInstanceConfig) {
        const {
            caching: {
                authorTTL,
                userNotesTTL,
                wikiTTL,
                commentTTL,
                submissionTTL,
                filterCriteriaTTL,
                provider,
            },
            name,
            credentials,
            caching,
        } = config;
        caching.provider.prefix = buildCachePrefix([caching.provider.prefix, 'SHARED']);
        this.cacheHash = objectHash.sha1(caching);
        this.defaultCacheConfig = caching;
        this.ttlDefaults = {authorTTL, userNotesTTL, wikiTTL, commentTTL, submissionTTL, filterCriteriaTTL};

        const options = provider;
        this.cacheType = options.store;
        this.defaultCache = createCacheManager(options);
        if (this.cacheType === 'memory') {
            const min = Math.min(...([this.ttlDefaults.wikiTTL, this.ttlDefaults.authorTTL, this.ttlDefaults.userNotesTTL].filter(x => typeof x === 'number' && x !== 0) as number[]));
            if (min > 0) {
                // set default prune interval
                this.pruneInterval = setInterval(() => {
                    // @ts-ignore
                    this.defaultCache?.store.prune();
                    // kinda hacky but whatever
                    const logger = winston.loggers.get('app');
                    logger.debug('Pruned Shared Cache');
                    // prune interval should be twice the smallest TTL
                }, min * 1000 * 2)
            }
        }
    }

    get(subName: string): SubredditResources | undefined {
        if (this.resources.has(subName)) {
            return this.resources.get(subName) as SubredditResources;
        }
        return undefined;
    }

    set(subName: string, initOptions: SubredditResourceConfig): SubredditResources {
        let hash = 'default';
        const { caching, ...init } = initOptions;

        let opts: SubredditResourceOptions = {
            cache: this.defaultCache,
            cacheType: this.cacheType,
            cacheSettingsHash: hash,
            ttl: this.ttlDefaults,
            prefix: this.defaultCacheConfig.provider.prefix,
            ...init,
        };

        if(caching !== undefined) {
            const {provider = this.defaultCacheConfig.provider, ...rest} = caching;
            let cacheConfig = {
                provider: buildCacheOptionsFromProvider(provider),
                ttl: {
                    ...this.ttlDefaults,
                    ...rest
                },
            }
            hash = objectHash.sha1(cacheConfig);
            // only need to create private if there settings are actually different than the default
            if(hash !== this.cacheHash) {
                const {provider: trueProvider, ...trueRest} = cacheConfig;
                const defaultPrefix = trueProvider.prefix;
                const subPrefix = defaultPrefix === this.defaultCacheConfig.provider.prefix ? buildCachePrefix([(defaultPrefix !== undefined ? defaultPrefix.replace('SHARED', '') : defaultPrefix), subName]) : trueProvider.prefix;
                trueProvider.prefix = subPrefix;
                opts = {
                    cache: createCacheManager(trueProvider),
                    cacheType: trueProvider.store,
                    cacheSettingsHash: hash,
                    prefix: subPrefix,
                    ...init,
                    ...trueRest,
                };
            }
        }

        let resource: SubredditResources;
        const res = this.get(subName);
        if(res === undefined || res.cacheSettingsHash !== hash) {
            if(res !== undefined && res.cache !== undefined) {
                res.cache.reset();
            }
            resource = new SubredditResources(subName, opts);
            this.resources.set(subName, resource);
        } else {
            // just set non-cache related settings
            resource = res;
            if(opts.footer !== resource.footer) {
                resource.footer = opts.footer || DEFAULT_FOOTER;
            }
            // reset cache stats when configuration is reloaded
            resource.stats.cache = cacheStats();
        }

        return resource;
    }
}
