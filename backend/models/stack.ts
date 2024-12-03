import { Model } from "objection";

export class Stack extends Model {
    static tableName = "stack";

    name!: string;
    directory_path?: string;
    created_at!: string;
    updated_at!: string;

    static get idColumn() {
        return "name";
    }
}