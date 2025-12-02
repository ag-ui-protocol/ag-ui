package com.agui.client.jsonpatch

import kotlinx.serialization.json.*

/*
 * Copyright 2023 Reid Byun.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

/*
*  JsonElement Extensions
* */

fun JsonElement.apply(patch: JsonElement): JsonElement {
	return JsonPatch.apply(patch, this)
}

fun JsonElement.generatePatch(with: JsonElement): JsonElement {
	return JsonDiff.asJson(this, with)
}

internal fun JsonElement.isContainerNode(): Boolean {
	return this is JsonArray || this is JsonObject
}

internal fun JsonElement.deepCopy(): JsonElement {
	return when(this) {
		is JsonArray -> this.jsonArray.copy {}
		is JsonObject -> this.jsonObject.copy {}
		is JsonNull -> JsonNull // An order of checking type between JsonNull and JsonPrimitive makes difference.
		is JsonPrimitive -> this /* Todo check */
	}
}

/*
* JsonArray Extensions
* */
internal fun JsonArray.add(value_: JsonElement?): JsonArray {
	val value=value_ ?: JsonNull
	return copy { add(value) }
}

internal fun JsonArray.insert(index: Int, value_: JsonElement?): JsonArray {
	val value=value_ ?: JsonNull
	return if(index>=size) {
		this.add(value)
	}
	else if(index<0) {
		this.copy { add(0, value)}
	}
	else {
		this.copy { add(index, value) }
	}
}

internal fun JsonArray.set(index: Int, value_: JsonElement?): JsonArray {
	val value=value_ ?: JsonNull
	if(index>=size) {
		throw IndexOutOfBoundsException("")
	}
	return copy { this[index] = value }
}

internal fun JsonArray.remove(index:Int): JsonArray {
	return copy { removeAt(index) }
}

private inline fun JsonArray.copy(mutatorBlock: MutableList<JsonElement>.() -> Unit): JsonArray {
	return JsonArray(this.toMutableList().apply(mutatorBlock))
}


/*
* JsonObject Extensions
* */
internal fun JsonObject.add(key: String, value_: JsonElement?): JsonObject {
	val value=value_ ?: JsonNull
	return copy {
		this[key] = value
	}
}

internal fun JsonObject.remove(key: String): JsonObject {
	return copy { remove(key) }
}

internal fun JsonObject.set(key: String, value_: JsonElement?): JsonObject {
	val value=value_ ?: JsonNull
	if(!this.containsKey(key)) {
		throw IndexOutOfBoundsException("Key[$key] doesn't exist")
	}
	return copy {
		this[key] = value
	}
}

internal fun JsonObject.addProperty(key: String, value: String): JsonObject {
	return this.copy {
		this[key] = JsonPrimitive(value)
	}
}

internal fun JsonObject.addProperty(key: String, value: Number): JsonObject {
	return this.copy {
		this[key] = JsonPrimitive(value)
	}
}

private inline fun JsonObject.copy(mutatorBlock: MutableMap<String, JsonElement>.() -> Unit): JsonObject {
	return JsonObject(this.toMutableMap().apply(mutatorBlock))
}
