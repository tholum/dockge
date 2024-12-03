<template>
    <div class="item-wrapper">
        <router-link :to="url" :class="{ 'dim' : !stack.isManagedByDockge }" class="item">
            <Uptime :stack="stack" :fixed-width="true" class="me-2" />
            <div class="title">
                <span>{{ stackName }}</span>
                <div v-if="$root.agentCount > 1" class="endpoint">{{ endpointDisplay }}</div>
            </div>
        </router-link>
        <button v-if="!stack.isManagedByDockge" class="button is-small is-light" @click="showSetPathDialog = true">
            <span class="icon">
                <i class="fas fa-folder"></i>
            </span>
            <span>Set Path</span>
        </button>
    </div>
    <SetPathDialog
        :show="showSetPathDialog"
        :stack-name="stackName"
        @close="showSetPathDialog = false"
        @saved="onPathSaved"
    />
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import Uptime from "./Uptime.vue";
import SetPathDialog from "./SetPathDialog.vue";

const props = defineProps({
    /** Stack this represents */
    stack: {
        type: Object,
        required: true,
    },
    /** If the user is in select mode */
    isSelectMode: {
        type: Boolean,
        default: false,
    },
    /** How many ancestors are above this stack */
    depth: {
        type: Number,
        default: 0,
    },
    /** Callback to determine if stack is selected */
    isSelected: {
        type: Function,
        default: () => {},
    },
    /** Callback fired when stack is selected */
    select: {
        type: Function,
        default: () => {},
    },
    /** Callback fired when stack is deselected */
    deselect: {
        type: Function,
        default: () => {},
    },
});

const isCollapsed = ref(true);
const showSetPathDialog = ref(false);

const endpointDisplay = computed(() => {
    return window.$root.endpointDisplayFunction(props.stack.endpoint);
});

const url = computed(() => {
    if (props.stack.endpoint) {
        return `/compose/${props.stack.name}/${props.stack.endpoint}`;
    } else {
        return `/compose/${props.stack.name}`;
    }
});

const depthMargin = computed(() => {
    return {
        marginLeft: `${31 * props.depth}px`,
    };
});

const stackName = computed(() => {
    return props.stack.name;
});

const onPathSaved = () => {
    // Refresh the page to update the stack status
    window.location.reload();
};

const changeCollapsed = () => {
    isCollapsed.value = !isCollapsed.value;

    // Save collapsed value into local storage
    let storage = window.localStorage.getItem("stackCollapsed");
    let storageObject = {};
    if (storage !== null) {
        storageObject = JSON.parse(storage);
    }
    storageObject[`stack_${props.stack.id}`] = isCollapsed.value;

    window.localStorage.setItem("stackCollapsed", JSON.stringify(storageObject));
};

const toggleSelection = () => {
    if (props.isSelected(props.stack.id)) {
        props.deselect(props.stack.id);
    } else {
        props.select(props.stack.id);
    }
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.collapse-padding {
    padding-left: 8px !important;
    padding-right: 2px !important;
}

.item-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 8px;
}

.item {
    text-decoration: none;
    display: flex;
    align-items: center;
    min-height: 52px;
    border-radius: 10px;
    transition: all ease-in-out 0.15s;
    flex-grow: 1;
    padding: 5px 8px;
    &.disabled {
        opacity: 0.3;
    }
    &:hover {
        background-color: $highlight-white;
    }
    &.active {
        background-color: #cdf8f4;
    }
    .title {
        margin-top: -4px;
    }
    .endpoint {
        font-size: 12px;
        color: $dark-font-color3;
    }
}

.collapsed {
    transform: rotate(-90deg);
}

.animated {
    transition: all 0.2s $easing-in;
}

.select-input-wrapper {
    float: left;
    margin-top: 15px;
    margin-left: 3px;
    margin-right: 10px;
    padding-left: 4px;
    position: relative;
    z-index: 15;
}

.dim {
    opacity: 0.5;
}

</style>
