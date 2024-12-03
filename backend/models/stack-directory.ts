import { Model } from "objection";

export class StackDirectory extends Model {
    static tableName = "stack_directory";

    stack_name!: string;
    directory_path!: string;
    created_at!: string;
    updated_at!: string;

    static get idColumn() {
        return "stack_name";
    }
}