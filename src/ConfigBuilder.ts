import {Logger} from "winston";
import {createAjvFactory, mergeArr, normalizeName} from "./util";
import {CommentCheck} from "./Check/CommentCheck";
import {SubmissionCheck} from "./Check/SubmissionCheck";

import Ajv from 'ajv';
import * as schema from './Schema/App.json';
import {JSONConfig} from "./JsonConfig";
import LoggedError from "./Utils/LoggedError";
import {CheckStructuredJson} from "./Check";
import {PollingOptions, PollingOptionsStrong, PollOn} from "./Common/interfaces";
import {isRuleSetJSON, RuleSetJson, RuleSetObjectJson} from "./Rule/RuleSet";
import deepEqual from "fast-deep-equal";
import {ActionJson, ActionObjectJson, RuleJson, RuleObjectJson} from "./Common/types";
import {isActionJson} from "./Action";

export interface ConfigBuilderOptions {
    logger: Logger,
}

export class ConfigBuilder {
    configLogger: Logger;
    logger: Logger;

    constructor(options: ConfigBuilderOptions) {

        this.configLogger = options.logger.child({leaf: 'Config'}, mergeArr);
        this.logger = options.logger;
    }

    validateJson(config: object): JSONConfig {
        const ajv = createAjvFactory(this.logger);
        const valid = ajv.validate(schema, config);
        if (valid) {
            return config as JSONConfig;
        } else {
            this.configLogger.error('Json config was not valid. Please use schema to check validity.');
            if (Array.isArray(ajv.errors)) {
                for (const err of ajv.errors) {
                    let parts = [
                        `At: ${err.dataPath}`,
                    ];
                    let data;
                    if (typeof err.data === 'string') {
                        data = err.data;
                    } else if (err.data !== null && typeof err.data === 'object' && (err.data as any).name !== undefined) {
                        data = `Object named '${(err.data as any).name}'`;
                    }
                    if (data !== undefined) {
                        parts.push(`Data: ${data}`);
                    }
                    let suffix = '';
                    // @ts-ignore
                    if (err.params.allowedValues !== undefined) {
                        // @ts-ignore
                        suffix = err.params.allowedValues.join(', ');
                        suffix = ` [${suffix}]`;
                    }
                    parts.push(`${err.keyword}: ${err.schemaPath} => ${err.message}${suffix}`);

                    // if we have a reference in the description parse it out so we can log it here for context
                    if(err.parentSchema !== undefined && err.parentSchema.description !== undefined) {
                        const desc = err.parentSchema.description as string;
                        const seeIndex = desc.indexOf('[See]');
                        if(seeIndex !== -1) {
                            let newLineIndex: number | undefined = desc.indexOf('\n', seeIndex);
                            if(newLineIndex === -1) {
                                newLineIndex = undefined;
                            }
                            const seeFragment = desc.slice(seeIndex + 5, newLineIndex);
                            parts.push(`See:${seeFragment}`);
                        }
                    }

                    this.configLogger.error(`Schema Error:\r\n${parts.join('\r\n')}`);
                }
            }
            throw new LoggedError('Config schema validity failure');
        }
    }

    parseToStructured(config: JSONConfig): CheckStructuredJson[] {
        let namedRules: Map<string, RuleObjectJson> = new Map();
        let namedActions: Map<string, ActionObjectJson> = new Map();
        const {checks = []} = config;
        for (const c of checks) {
            const {rules = []} = c;
            namedRules = extractNamedRules(rules, namedRules);
            namedActions = extractNamedActions(c.actions, namedActions);
        }

        const structuredChecks: CheckStructuredJson[] = [];
        for (const c of checks) {
            const {rules = []} = c;
            const strongRules = insertNamedRules(rules, namedRules);
            const strongActions = insertNamedActions(c.actions, namedActions);
            const strongCheck = {...c, rules: strongRules, actions: strongActions} as CheckStructuredJson;
            structuredChecks.push(strongCheck);
        }

        return structuredChecks;
    }
}

export const buildPollingOptions = (values: (string | PollingOptions)[]): PollingOptionsStrong[] => {
    let opts: PollingOptionsStrong[] = [];
    for (const v of values) {
        if (typeof v === 'string') {
            opts.push({pollOn: v as PollOn, interval: 10000, limit: 25});
        } else {
            const {
                pollOn: p,
                interval = 20000,
                limit = 25
            } = v;
            opts.push({pollOn: p as PollOn, interval, limit});
        }
    }
    return opts;
}

export const extractNamedRules = (rules: Array<RuleSetJson | RuleJson>, namedRules: Map<string, RuleObjectJson> = new Map()): Map<string, RuleObjectJson> => {
    //const namedRules = new Map();
    for (const r of rules) {
        let rulesToAdd: RuleObjectJson[] = [];
        if ((typeof r === 'object')) {
            if ((r as RuleObjectJson).kind !== undefined) {
                // itsa rule
                const rule = r as RuleObjectJson;
                if (rule.name !== undefined) {
                    rulesToAdd.push(rule);
                }
            } else {
                const ruleSet = r as RuleSetJson;
                const nestedNamed = extractNamedRules(ruleSet.rules);
                rulesToAdd = [...nestedNamed.values()];
            }
            for (const rule of rulesToAdd) {
                const name = rule.name as string;
                const normalName = normalizeName(name);
                const {name: n, ...rest} = rule;
                const ruleNoName = {...rest};

                if (namedRules.has(normalName)) {
                    const {name: nn, ...ruleRest} = namedRules.get(normalName) as RuleObjectJson;
                    if (!deepEqual(ruleRest, ruleNoName)) {
                        throw new Error(`Rule names must be unique (case-insensitive). Conflicting name: ${name}`);
                    }
                } else {
                    namedRules.set(normalName, rule);
                }
            }
        }
    }
    return namedRules;
}

export const insertNamedRules = (rules: Array<RuleSetJson | RuleJson>, namedRules: Map<string, RuleObjectJson> = new Map()): Array<RuleSetObjectJson | RuleObjectJson> => {
    const strongRules: Array<RuleSetObjectJson | RuleObjectJson> = [];
    for (const r of rules) {
        if (typeof r === 'string') {
            const foundRule = namedRules.get(r.toLowerCase());
            if (foundRule === undefined) {
                throw new Error(`No named Rule with the name ${r} was found`);
            }
            strongRules.push(foundRule);
        } else if (isRuleSetJSON(r)) {
            const {rules: sr, ...rest} = r;
            const setRules = insertNamedRules(sr, namedRules);
            const strongSet = {rules: setRules, ...rest} as RuleSetObjectJson;
            strongRules.push(strongSet);
        } else {
            strongRules.push(r);
        }
    }

    return strongRules;
}

export const extractNamedActions = (actions: Array<ActionJson>, namedActions: Map<string, ActionObjectJson> = new Map()): Map<string, ActionObjectJson> => {
    for (const a of actions) {
        if (!(typeof a === 'string')) {
            if (isActionJson(a) && a.name !== undefined) {
                const normalName = a.name.toLowerCase();
                const {name: n, ...rest} = a;
                const actionNoName = {...rest};
                if (namedActions.has(normalName)) {
                    // @ts-ignore
                    const {name: nn, ...aRest} = namedActions.get(normalName) as ActionObjectJson;
                    if (!deepEqual(aRest, actionNoName)) {
                        throw new Error(`Actions names must be unique (case-insensitive). Conflicting name: ${a.name}`);
                    }
                } else {
                    namedActions.set(normalName, a);
                }
            }
        }
    }
    return namedActions;
}

export const insertNamedActions = (actions: Array<ActionJson>, namedActions: Map<string, ActionObjectJson> = new Map()): Array<ActionObjectJson> => {
    const strongActions: Array<ActionObjectJson> = [];
    for (const a of actions) {
        if (typeof a === 'string') {
            const foundAction = namedActions.get(a.toLowerCase());
            if (foundAction === undefined) {
                throw new Error(`No named Action with the name ${a} was found`);
            }
            strongActions.push(foundAction);
        } else {
            strongActions.push(a);
        }
    }

    return strongActions;
}
