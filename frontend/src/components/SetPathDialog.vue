<template>
    <div class="modal" :class="{ 'is-active': show }">
        <div class="modal-background" @click="close"></div>
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title">
                    <span class="icon">
                        <i class="fas fa-folder"></i>
                    </span>
                    <span>Set Stack Directory</span>
                </p>
                <button class="delete" aria-label="close" @click="close"></button>
            </header>
            <section class="modal-card-body">
                <div class="field">
                    <label class="label">Directory Path</label>
                    <div class="control has-icons-left">
                        <input class="input" type="text" v-model="directoryPath" placeholder="/path/to/stack/directory">
                        <span class="icon is-small is-left">
                            <i class="fas fa-folder"></i>
                        </span>
                    </div>
                    <p class="help">Enter the absolute path to the directory containing your compose file</p>
                </div>
            </section>
            <footer class="modal-card-foot">
                <button class="button is-primary" @click="save" :class="{ 'is-loading': loading }">
                    <span class="icon">
                        <i class="fas fa-save"></i>
                    </span>
                    <span>Save</span>
                </button>
                <button class="button is-light" @click="close">
                    <span class="icon">
                        <i class="fas fa-times"></i>
                    </span>
                    <span>Cancel</span>
                </button>
            </footer>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, watch, withDefaults } from "vue";

const props = withDefaults(defineProps<{
    show: boolean;
    stackName: string;
}>(), {
    show: false
});

// Watch for show prop changes
watch(() => props.show, (newValue) => {
    console.log('Dialog show prop changed:', newValue);
});

const emit = defineEmits<{
    (e: "close"): void;
    (e: "saved"): void;
}>();

declare global {
    interface Window {
        $notification: {
            success: (msg: string) => void;
            error: (msg: string) => void;
        };
    }
}

const toast = {
    success: (msg: string) => window.$notification.success(msg),
    error: (msg: string) => window.$notification.error(msg),
};
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

<style lang="scss" scoped>
.modal-card-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.modal {
    display: none;
    &.is-active {
        display: flex;
    }
}

.modal-card-foot {
    justify-content: flex-end;
    gap: 0.5rem;
}
</style>