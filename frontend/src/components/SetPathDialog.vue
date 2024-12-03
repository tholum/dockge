<template>
    <div class="modal" :class="{ 'is-active': show }">
        <div class="modal-background" @click="close"></div>
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title">Set Stack Directory</p>
                <button class="delete" aria-label="close" @click="close"></button>
            </header>
            <section class="modal-card-body">
                <div class="field">
                    <label class="label">Directory Path</label>
                    <div class="control">
                        <input class="input" type="text" v-model="directoryPath" placeholder="/path/to/stack/directory">
                    </div>
                    <p class="help">Enter the absolute path to the directory containing your compose file</p>
                </div>
            </section>
            <footer class="modal-card-foot">
                <button class="button is-success" @click="save" :class="{ 'is-loading': loading }">Save</button>
                <button class="button" @click="close">Cancel</button>
            </footer>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useToast } from "vue-toastification";

const props = defineProps<{
    show: boolean;
    stackName: string;
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "saved"): void;
}>();

const toast = useToast();
const directoryPath = ref("");
const loading = ref(false);

const close = () => {
    directoryPath.value = "";
    emit("close");
};

const save = async () => {
    if (!directoryPath.value) {
        toast.error("Please enter a directory path");
        return;
    }

    loading.value = true;
    try {
        const response = await fetch(`/api/stacks/${props.stackName}/path`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                directoryPath: directoryPath.value,
            }),
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.message || "Failed to set path");
        }

        toast.success("Stack path updated successfully");
        emit("saved");
        close();
    } catch (error) {
        if (error instanceof Error) {
            toast.error(error.message);
        } else {
            toast.error("Failed to set path");
        }
    } finally {
        loading.value = false;
    }
};
</script>