package com.agui.client.jsonpatch

import kotlinx.serialization.json.*


internal object NodeType {
    val ARRAY = 1
    val OBJECT = 2
    //    static final int NULL=3;
    val PRIMITIVE_OR_NULL = 3

    fun getNodeType(node: JsonElement): Int {
        if (node is JsonArray) return ARRAY
        if (node is JsonObject) return OBJECT
        //        if(node.isJsonNull()) return NULL;
        return PRIMITIVE_OR_NULL
    }
}
