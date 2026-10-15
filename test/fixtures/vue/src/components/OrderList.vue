<script setup lang="ts">
import { ref } from "vue";
import OrderCard from "./OrderCard.vue";
import { formatTotal } from "@/orders";
import type { Order } from "@/types";

const props = defineProps<{ orders: Order[] }>();
const query = ref("");
let selected: Order | undefined;

function select(order: Order): void {
    selected = order;
}

function refresh(): void {
}
</script>

<template>
  <input v-model="query" @keyup.enter="refresh">
  <ul>
    <li v-for="(order, index) in orders" :key="order.id" @click="select(order)">
      {{ index }} {{ order.customer.name }} {{ formatTotal(order) }}
    </li>
  </ul>
  <OrderCard v-if="selected" :order="selected" label="Selected" @select="select" />
  <order-card v-for="order in props.orders" :key="order.id" :order="order" label="All" />
</template>
