<template>
    <div class="modal" :class="{ 'is-active': show }">
        <div class="modal-background" @click="close"></div>
        <div class="modal-content">
            <div class="box">
                <div class="modal-header">
                    <div class="modal-title">
                        <span class="icon">
                            <i class="fas fa-folder"></i>
                        </span>
                        <span>Set Stack Directory</span>
                    </div>
                    <button class="delete" aria-label="close" @click="close"></button>
                </div>

                <div class="field mt-4">
                    <label class="label">Directory Path</label>
                    <div class="control has-icons-left">
                        <input 
                            class="input" 
                            type="text" 
                            v-model="directoryPath" 
                            placeholder="/path/to/stack/directory"
                            :class="{ 'is-danger': error }"
                        >
                        <span class="icon is-small is-left">
                            <i class="fas fa-folder"></i>
                        </span>
                    </div>
                    <p class="help" :class="{ 'is-danger': error }">
                        {{ error || 'Enter the absolute path to the directory containing your compose file' }}
                    </p>
                </div>

                <div class="field is-grouped is-grouped-right mt-5">
                    <p class="control">
                        <button class="button is-primary" @click="save" :class="{ 'is-loading': loading }">
                            <span class="icon">
                                <i class="fas fa-save"></i>
                            </span>
                            <span>Save</span>
                        </button>
                    </p>
                    <p class="control">
                        <button class="button is-light" @click="close">
                            <span class="icon">
                                <i class="fas fa-times"></i>
                            </span>
                            <span>Cancel</span>
                        </button>
                    </p>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, watch, withDefaults } from "vue";
import socketMixin from "../mixins/socket";
import { useToast } from "vue-toastification";

const socket = socketMixin.methods.getSocket();
const toast = useToast();
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

const error = ref("");
const directoryPath = ref("");
const loading = ref(false);

const close = () => {
    directoryPath.value = "";
    error.value = "";
    emit("close");
};

const save = async () => {
    error.value = "";
    if (!directoryPath.value) {
        error.value = "Please enter a directory path";
        toast.error("Please enter a directory path");
        return;
    }

    loading.value = true;
    try {
        socket.emit("setStackPath", {
            stackName: props.stackName,
            directoryPath: directoryPath.value,
        }, (response: { ok: boolean; msg?: string }) => {
            loading.value = false;
            if (response.ok) {
                toast.success(response.msg || "Stack path updated successfully");
                emit("saved");
                close();
            } else {
                const message = response.msg || "Failed to set path";
                error.value = message;
                toast.error(message);
            }
        });
    } catch (e) {
        loading.value = false;
        const message = e instanceof Error ? e.message : "Failed to set path";
        error.value = message;
        toast.error(message);
    }
};
</script>

<style lang="scss" scoped>
.modal {
    display: none;
    &.is-active {
        display: flex;
    }
}

.modal-content {
    max-width: 500px;
    width: 100%;
    margin: 0 auto;
}

.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
}

.modal-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
}

.box {
    margin: 1rem;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
</style>