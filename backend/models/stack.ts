import { Bean } from "redbean-node/dist/bean";

export class Stack extends Bean {
    name!: string;
    directory_path?: string;
    created_at!: string;
    updated_at!: string;
}