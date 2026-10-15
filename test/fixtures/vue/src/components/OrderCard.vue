<script setup lang="ts">
import type { Order } from "@/types";

defineProps<{ order: Order; label: string }>();
const emit = defineEmits<{ select: [order: Order] }>();
</script>

<template>
  <div class="card" @click="emit('select', order)">{{ label }}: {{ order.id }}</div>
</template>
