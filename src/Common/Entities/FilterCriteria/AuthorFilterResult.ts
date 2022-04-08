import {ChildEntity, ManyToOne, OneToMany} from "typeorm";
import {FilterResult} from "./FilterResult";
import {
    AuthorCriteria,
    FilterCriteriaResult as IFilterCriteriaResult,
    FilterResult as IFilterResult,
} from "../../interfaces";
import {AuthorFilterCriteriaResult} from "./FilterCriteriaResult";

@ChildEntity()
export class AuthorFilterResult extends FilterResult<AuthorCriteria> {

    type: string = 'author';

    @OneToMany(type => AuthorFilterCriteriaResult, obj => obj.filterResult, {cascade: ['insert'], eager: true})
    criteriaResults!: AuthorFilterCriteriaResult[]

    constructor(data?: IFilterResult<AuthorCriteria>) {
        super(data);
        if(data !== undefined) {
            this.criteriaResults = data.criteriaResults.map(x => new AuthorFilterCriteriaResult(x))
        }
    }
}
