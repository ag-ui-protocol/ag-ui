/*
 * Copyright 2016 flipkart.com zjsonpatch.
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

package com.agui.client.jsonpatch

import kotlinx.serialization.json.JsonElement

/** A JSON patch processor that does nothing, intended for testing and validation.  */
class NoopProcessor : JsonPatchApplyProcessor() {
    companion object {
        val INSTANCE: NoopProcessor = NoopProcessor()
    }
}

class JsonPatchEditingContextTestImpl(var source: JsonElement): JsonPatchEditingContext {
    override fun remove(path: List<String>) {}
    override fun replace(path: List<String>, value: JsonElement) {}
    override fun add(path: List<String>, value: JsonElement) {}
    override fun move(fromPath: List<String>, toPath: List<String>) {}
    override fun copy(fromPath: List<String>, toPath: List<String>) {}
    override fun test(path: List<String>, value: JsonElement) {}
}