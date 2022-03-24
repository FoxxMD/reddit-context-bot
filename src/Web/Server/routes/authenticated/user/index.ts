import {Request, Response} from 'express';
import {authUserCheck, botRoute, subredditRoute} from "../../../middleware";
import Submission from "snoowrap/dist/objects/Submission";
import winston from 'winston';
import {COMMENT_URL_ID, parseLinkIdentifier, SUBMISSION_URL_ID} from "../../../../../util";
import {booleanMiddle} from "../../../../Common/middleware";
import {Manager} from "../../../../../Subreddit/Manager";
import {ActionedEvent} from "../../../../../Common/interfaces";
import {CMEvent, CMEvent as ActionedEventEntity} from "../../../../../Common/Entities/CMEvent";
import {nanoid} from "nanoid";
import dayjs from "dayjs";
import {paginateRequest} from "../../../../Common/util";

const commentReg = parseLinkIdentifier([COMMENT_URL_ID]);
const submissionReg = parseLinkIdentifier([SUBMISSION_URL_ID]);

const config = async (req: Request, res: Response) => {

    const manager = req.manager as Manager;

    // @ts-ignore
    const wiki = await manager.subreddit.getWikiPage(manager.wikiLocation).fetch();
    return res.send(wiki.content_md);
};
export const configRoute = [authUserCheck(), botRoute(), subredditRoute(), config];

const configLocation = async (req: Request, res: Response) => {
    const manager = req.manager as Manager;
    return res.send(manager.wikiLocation);
};

export const configLocationRoute = [authUserCheck(), botRoute(), subredditRoute(), configLocation];

const getInvites = async (req: Request, res: Response) => {

    return res.json(await req.serverBot.cacheManager.getPendingSubredditInvites());
};

export const getInvitesRoute = [authUserCheck(), botRoute(), getInvites];

const addInvite = async (req: Request, res: Response) => {

    const {subreddit} = req.body as any;
    if (subreddit === undefined || subreddit === null || subreddit === '') {
        return res.status(400).send('subreddit must be defined');
    }
    await req.serverBot.cacheManager.addPendingSubredditInvite(subreddit);
    return res.status(200).send();
};

export const addInviteRoute = [authUserCheck(), botRoute(), addInvite];

const deleteInvite = async (req: Request, res: Response) => {

    const {subreddit} = req.query as any;
    if (subreddit === undefined || subreddit === null || subreddit === '') {
        return res.status(400).send('subreddit must be defined');
    }
    await req.serverBot.cacheManager.deletePendingSubredditInvite(subreddit);
    return res.status(200).send();
};

export const deleteInviteRoute = [authUserCheck(), botRoute(), deleteInvite];

const actionedEvents = async (req: Request, res: Response) => {

    let managers: Manager[] = [];
    const manager = req.manager as Manager | undefined;
    if(manager !== undefined) {
        managers.push(manager);
    } else {
        for(const manager of req.serverBot.subManagers) {
            if(req.user?.canAccessSubreddit(req.serverBot, manager.subreddit.display_name)) {
                managers.push(manager);
            }
        }
    }

    const query = req.serverBot.database.getRepository(CMEvent)
        .createQueryBuilder("event")
        .leftJoinAndSelect('event.source', 'source')
        .leftJoinAndSelect('event.activity', 'activity')
        .leftJoinAndSelect('activity.subreddit', 'subreddit')
        .leftJoinAndSelect('activity.author', 'author')
        .leftJoinAndSelect('event.runResults', 'runResults')
        .leftJoinAndSelect('runResults._authorIs', 'rrAuthorIs')
        .leftJoinAndSelect('runResults._itemIs', 'rrItemIs')
        .leftJoinAndSelect('rrAuthorIs.criteriaResults', 'rrAuthorCritResults')
        .leftJoinAndSelect('rrItemIs.criteriaResults', 'rrItemCritResults')
        .leftJoinAndSelect('runResults.run', 'run')
        .leftJoinAndSelect('runResults.checkResults', 'checkResults')
        .leftJoinAndSelect('checkResults._authorIs', 'cAuthorIs')
        .leftJoinAndSelect('checkResults._itemIs', 'cItemIs')
        .leftJoinAndSelect('cAuthorIs.criteriaResults', 'cAuthorCritResults')
        .leftJoinAndSelect('cItemIs.criteriaResults', 'cItemCritResults')
        .leftJoinAndSelect('checkResults.ruleResults', 'ruleResults')
        .leftJoinAndSelect('ruleResults._authorIs', 'rAuthorIs')
        .leftJoinAndSelect('ruleResults._itemIs', 'rItemIs')
        .leftJoinAndSelect('rAuthorIs.criteriaResults', 'rAuthorCritResults')
        .leftJoinAndSelect('rItemIs.criteriaResults', 'rItemCritResults')
        .leftJoinAndSelect('checkResults.actionResults', 'actionResults')
        .leftJoinAndSelect('actionResults._authorIs', 'aAuthorIs')
        .leftJoinAndSelect('actionResults._itemIs', 'aItemIs')
        .leftJoinAndSelect('aAuthorIs.criteriaResults', 'aAuthorCritResults')
        .leftJoinAndSelect('aItemIs.criteriaResults', 'aItemCritResults')
        .andWhere('event.manager.id IN (:...managerIds)', {managerIds: managers.map(x => x.managerEntity.id)})
        .orderBy('event.processedAt', 'DESC')

    // TODO will need to refactor this if we switch to allowing subreddits to use their own datasources
    return res.json(await paginateRequest(query, req));
};
export const actionedEventsRoute = [authUserCheck(), botRoute(), subredditRoute(false), actionedEvents];

const action = async (req: Request, res: Response) => {
    const bot = req.serverBot;

    const {url, dryRun = false, subreddit} = req.query as any;
    const {name: userName} = req.user as Express.User;

    let a;
    const commentId = commentReg(url);
    if (commentId !== undefined) {
        // @ts-ignore
        a = await bot.client.getComment(commentId);
    }
    if (a === undefined) {
        const submissionId = submissionReg(url);
        if (submissionId !== undefined) {
            // @ts-ignore
            a = await bot.client.getSubmission(submissionId);
        }
    }

    if (a === undefined) {
        winston.loggers.get('app').error('Could not parse Comment or Submission ID from given URL', {user: userName});
        return res.send('OK');
    } else {
        // @ts-ignore
        const activity = await a.fetch();
        const sub = await activity.subreddit.display_name;

        let manager = subreddit === 'All' ? bot.subManagers.find(x => x.subreddit.display_name === sub) : bot.subManagers.find(x => x.displayLabel === subreddit);

        if (manager === undefined || !req.user?.canAccessSubreddit(req.serverBot, manager.subreddit.display_name)) {
            let msg = 'Activity does not belong to a subreddit you moderate or the bot runs on.';
            if (subreddit === 'All') {
                msg = `${msg} If you want to test an Activity against a Subreddit's config it does not belong to then switch to that Subreddit's tab first.`
            }
            winston.loggers.get('app').error(msg, {user: userName});
            return res.send('OK');
        }

        // will run dryrun if specified or if running activity on subreddit it does not belong to
        const dr: boolean | undefined = (dryRun || manager.subreddit.display_name !== sub) ? true : undefined;
        manager.logger.info(`/u/${userName} Queued ${dr === true ? 'DRY RUN ' : ''}check on ${manager.subreddit.display_name !== sub ? 'FOREIGN ACTIVITY ' : ''}${url}`, {user: userName, subreddit});
        await manager.firehose.push({
            activity, options: {
                dryRun: dr,
                force: true,
                source: `user:${userName}`,
                activitySource: {
                    delay: 0,
                    id: nanoid(16),
                    type: 'user',
                    identifier: userName,
                    queuedAt: dayjs().valueOf(),
                }
            }
        })
    }
    res.send('OK');
};

export const actionRoute = [authUserCheck(), botRoute(), booleanMiddle(['dryRun']), action];

const cancelDelayed = async (req: Request, res: Response) => {

    const {id} = req.query as any;
    const {name: userName} = req.user as Express.User;

    if(req.manager?.resources === undefined) {
        req.manager?.logger.error('Subreddit does not have delayed items!', {user: userName});
        return res.status(400).send();
    }

    const delayedItem = req.manager.resources.delayedItems.find(x => x.id === id);
    if(delayedItem === undefined) {
        req.manager?.logger.error(`No delayed items exists with the id ${id}`, {user: userName});
        return res.status(400).send();
    }

    req.manager.resources.delayedItems = req.manager.resources.delayedItems.filter(x => x.id !== id);
    req.manager?.logger.info(`Remove Delayed Item '${delayedItem.id}'`, {user: userName});
    return res.send('OK');
};

export const cancelDelayedRoute = [authUserCheck(), botRoute(), subredditRoute(true), cancelDelayed];
