import { Model } from "objection";

export class StackPath extends Model {
    static tableName = "stack_paths";

    stack_name!: string;
    directory_path!: string;
    created_at!: string;
    updated_at!: string;

    static get idColumn() {
        return "stack_name";
    }
}